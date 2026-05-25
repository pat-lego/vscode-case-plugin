import { getState, setState, InboundMessage, OutboundMessage } from '../bridge/websocket.js';

let ws: WebSocket | null = null;

function log(...args: unknown[]) {
  console.log('[II-bg]', ...args);
}

// Guard against "Extension context invalidated" — Chrome can fire pending
// callbacks after the SW is terminated; any chrome.* call in that state throws.
function isContextValid(): boolean {
  try { return !!chrome.runtime.id; } catch { return false; }
}

log('service worker started');

// Mark disconnected on restart but keep activeCase — it will be refreshed
// from VS Code once the WebSocket reconnects.
setState({ connected: false }).then(() => log('initial setState done'));

async function connect() {
  const state = await getState();
  const url = `ws://127.0.0.1:${state.port}`;
  log(`connect() ws.readyState=${ws?.readyState ?? 'null'} url=${url}`);

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    log('already connected/connecting — skipping');
    return;
  }

  log('creating WebSocket...');
  ws = new WebSocket(url);

  ws.onopen = async () => {
    log('onopen — connected');
    await setState({ connected: true });
    notifyPopup({ type: 'stateChanged' });
    startPing();
    // Fetch active case via HTTP — more reliable than waiting for a WS message.
    fetchActiveCase(state.port);
    // Also send queryActiveCase over WS as a fallback in case WS messages work.
    setTimeout(() => {
      log('sending queryActiveCase over WS');
      send({ type: 'queryActiveCase' });
    }, 300);
  };

  ws.onmessage = async (event) => {
    try {
      const msg: InboundMessage = JSON.parse(event.data as string);
      log('onmessage', msg.type, msg.caseId ?? '');
      if (msg.type === 'activeCase' && msg.caseId && msg.title) {
        await setState({ activeCase: { caseId: msg.caseId, title: msg.title } });
        log('stored activeCase', msg.caseId);
      } else if (msg.type === 'noActiveCase') {
        await setState({ activeCase: null });
        log('cleared activeCase');
      }
      notifyPopup({ type: 'stateChanged' });
    } catch (e) {
      log('onmessage error', e);
    }
  };

  ws.onclose = async (ev) => {
    log(`onclose code=${ev.code} reason=${ev.reason}`);
    ws = null;
    if (!isContextValid()) return;
    try {
      await setState({ connected: false });
      notifyPopup({ type: 'stateChanged' });
      scheduleReconnect();
    } catch (e) {
      log('onclose error (context gone):', e);
    }
  };

  ws.onerror = (ev) => {
    log('onerror', ev);
    ws?.close();
  };
}

async function fetchActiveCase(port: number) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/state`);
    const data = await res.json() as { type: string; caseId?: string; title?: string };
    log('fetchActiveCase response:', data.type, data.caseId ?? '');
    if (data.type === 'activeCase' && data.caseId && data.title) {
      await setState({ activeCase: { caseId: data.caseId, title: data.title } });
      log('stored activeCase via HTTP', data.caseId);
    } else if (data.type === 'noActiveCase') {
      await setState({ activeCase: null });
      log('no active case (HTTP)');
    }
    notifyPopup({ type: 'stateChanged' });
  } catch (e) {
    log('fetchActiveCase error:', e);
  }
}

function scheduleReconnect() {
  // Use alarms instead of setTimeout so the reconnect survives SW termination.
  // chrome.alarms minimum is ~1 min in production, but "periodInMinutes: 1/3"
  // already handles the keep-alive. The alarm named "reconnect" is a one-shot
  // that fires as soon as Chrome allows (typically ~30s minimum).
  if (!isContextValid()) return;
  chrome.alarms.create('reconnect', { delayInMinutes: 0.1 });
  log('reconnect alarm scheduled');
}

function startPing() {
  setInterval(() => {
    send({ type: 'ping' });
  }, 20000);
}

function send(msg: OutboundMessage): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

// Send a message to the content script, injecting it first if not yet loaded.
function sendToContentScript(
  tabId: number,
  message: Record<string, unknown>,
  respond: (r: unknown) => void
) {
  chrome.tabs.sendMessage(tabId, message, (result) => {
    if (!chrome.runtime.lastError && result !== undefined) {
      respond(result);
      return;
    }
    // Content script not loaded (e.g. tab predates extension load) — inject now.
    log('content script not found, injecting into tab', tabId);
    chrome.scripting.executeScript(
      { target: { tabId }, files: ['dist/content/index.js'] },
      () => {
        if (chrome.runtime.lastError) {
          respond({ ok: false, error: chrome.runtime.lastError.message ?? 'Inject failed' });
          return;
        }
        chrome.tabs.sendMessage(tabId, message, (r) => {
          respond(r ?? { ok: false, error: 'No response after inject' });
        });
      }
    );
  });
}

function notifyPopup(msg: object) {
  chrome.runtime.sendMessage(msg).catch(() => { /* popup may not be open */ });
}

// Keep service worker alive and handle reconnects via alarms (MV3-safe).
chrome.alarms.create('keepAlive', { periodInMinutes: 1/3 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!isContextValid()) return;
  log('alarm fired:', alarm.name);
  if (alarm.name === 'keepAlive' || alarm.name === 'reconnect') {
    connect();
  }
});

// Message handler for requests from popup and content scripts
chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, _sender, sendResponse) => {
  if (msg.type === 'getState') {
    getState().then(s => sendResponse(s));
    return true;
  }

  if (msg.type === 'sendCapture') {
    const outbound = msg.payload as OutboundMessage;
    getState().then(async state => {
      try {
        const res = await fetch(`http://127.0.0.1:${state.port}/capture`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(outbound)
        });
        const data = await res.json() as { ok: boolean; error?: string };
        if (data.ok) {
          await setState({ captureCount: state.captureCount + 1 });
          notifyPopup({ type: 'stateChanged' });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: data.error ?? 'Capture failed' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: 'Could not reach VS Code bridge' });
      }
    });
    return true;
  }

  if (msg.type === 'updatePort') {
    setState({ port: msg.port as number }).then(() => {
      ws?.close();
      connect();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'captureTab') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) { sendResponse({ ok: false, error: 'No active tab' }); return; }
      sendToContentScript(tab.id, { type: 'triggerCapture' }, sendResponse);
    });
    return true;
  }

  if (msg.type === 'captureScreenshot') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id || !tab.windowId) { sendResponse({ ok: false, error: 'No active tab' }); return; }
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          sendResponse({ ok: false, error: chrome.runtime.lastError?.message ?? 'Screenshot failed' });
          return;
        }
        const now = new Date();
        const hhmm = String(now.getHours()).padStart(2, '0') + 'h' + String(now.getMinutes()).padStart(2, '0');
        const payload: OutboundMessage = {
          type: 'screenshot',
          source: tab.url ?? '',
          name: `screenshot-${hhmm}.png`,
          data: dataUrl,
          timestamp: now.toISOString()
        };
        getState().then(async state => {
          try {
            const res = await fetch(`http://127.0.0.1:${state.port}/capture`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            const data = await res.json() as { ok: boolean; error?: string };
            if (data.ok) {
              await setState({ captureCount: state.captureCount + 1 });
              notifyPopup({ type: 'stateChanged' });
              sendResponse({ ok: true });
            } else {
              sendResponse({ ok: false, error: data.error ?? 'Screenshot failed' });
            }
          } catch (e) {
            sendResponse({ ok: false, error: 'Could not reach VS Code bridge' });
          }
        });
      });
    });
    return true;
  }

  if (msg.type === 'refreshActiveCase') {
    getState().then(state => fetchActiveCase(state.port));
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'captureSelection') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) { sendResponse({ ok: false, error: 'No active tab' }); return; }
      sendToContentScript(tab.id, { type: 'triggerSelectionCapture' }, sendResponse);
    });
    return true;
  }
});

// Start connecting on load
connect();
