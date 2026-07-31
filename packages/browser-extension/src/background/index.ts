import { getState, setState, InboundMessage, OutboundMessage } from '../bridge/websocket.js';
import { captureTimestamp } from '../utils/capture-name.js';

let ws: WebSocket | null = null;
let connectWatchdog: ReturnType<typeof setTimeout> | undefined;

// If a connection attempt doesn't resolve (open or close/error) within this
// window, force it closed and retry. Without this, a hung CONNECTING socket
// blocks every future attempt forever — see the guard at the top of connect().
const CONNECT_TIMEOUT_MS = 5000;

function log(level: 'DEBUG'|'INFO'|'WARN'|'ERROR', msg: string, ctx?: Record<string, unknown>) {
  const ts = new Date().toISOString().slice(11, 23);
  const ctxStr = ctx && Object.keys(ctx).length > 0 ? ' ' + JSON.stringify(ctx) : '';
  const line = `[${ts}] [${level}] [II-bg] ${msg}${ctxStr}`;
  if (level === 'ERROR' || level === 'WARN') {
    console.error(line);
  } else {
    console.log(line);
  }
}

// Guard against "Extension context invalidated" — Chrome can fire pending
// callbacks after the SW is terminated; any chrome.* call in that state throws.
function isContextValid(): boolean {
  try { return !!chrome.runtime.id; } catch { return false; }
}

// Numeric WebSocket.readyState is meaningless in logs — map it to a name.
// NOTE: this is the ONLY thing that drives the popup's connected/disconnected
// dot. VS Code's status bar, by contrast, shows "connected" for up to 60s
// after its *last activity* (any WS message OR plain HTTP request) even with
// zero open WS clients — see BridgeServer.ACTIVITY_TTL in bridge-server.ts.
// So a mismatch where VS Code says "connected" and this popup says
// "disconnected" almost always means: the WS closed (often because the SW
// was suspended/terminated by Chrome and the reconnect alarm hasn't fired
// yet), while VS Code is still inside that 60s grace window. Check
// `wsReadyState`/`reconnectAttempts`/`lastDisconnectedAt` in the popup debug
// line, and the background service worker console
// (chrome://extensions → this extension → "service worker" → Inspect), to
// confirm.
function readyStateName(state: number | undefined | null): string {
  switch (state) {
    case WebSocket.CONNECTING: return 'CONNECTING';
    case WebSocket.OPEN: return 'OPEN';
    case WebSocket.CLOSING: return 'CLOSING';
    case WebSocket.CLOSED: return 'CLOSED';
    default: return 'NONE';
  }
}

log('INFO', 'service worker started');

// Mark disconnected on restart but keep activeCase — it will be refreshed
// from VS Code once the WebSocket reconnects.
setState({ connected: false, wsReadyState: 'CLOSED' }).then(() => log('INFO', 'initial state reset to disconnected'));

async function connect() {
  const state = await getState();
  const url = `ws://127.0.0.1:${state.port}`;
  log('INFO', 'connect()', { readyState: readyStateName(ws?.readyState), url });

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    log('DEBUG', 'connect: already connected/connecting — skip', { readyState: readyStateName(ws.readyState) });
    return;
  }

  log('INFO', 'creating WebSocket', { url });
  await setState({ wsReadyState: 'CONNECTING' });
  ws = new WebSocket(url);

  // Known MV3 gotcha: an extension service worker can be suspended mid-
  // handshake, orphaning the socket — VS Code's server may have already
  // accepted the TCP/WS connection (so its status bar shows "connected"),
  // but this side never gets the onopen callback to know it, and readyState
  // is stuck at CONNECTING forever. Since the guard above treats CONNECTING
  // as "an attempt is already in flight, don't retry", a hang here would
  // otherwise block every future reconnect permanently. Force it closed
  // after CONNECT_TIMEOUT_MS so onclose fires and scheduleReconnect() runs.
  clearTimeout(connectWatchdog);
  const watchdogFor = ws;
  connectWatchdog = setTimeout(() => {
    if (watchdogFor.readyState === WebSocket.CONNECTING) {
      log('WARN', 'connection attempt timed out — forcing close to retry', { url, timeoutMs: CONNECT_TIMEOUT_MS });
      watchdogFor.close();
    }
  }, CONNECT_TIMEOUT_MS);

  ws.onopen = async () => {
    clearTimeout(connectWatchdog);
    log('INFO', 'WebSocket connected', { url });
    await setState({
      connected: true,
      wsReadyState: 'OPEN',
      lastConnectedAt: new Date().toISOString(),
      lastError: null,
      reconnectAttempts: 0
    });
    notifyPopup({ type: 'stateChanged' });
    startPing();
    // Fetch active case via HTTP — more reliable than waiting for a WS message.
    fetchActiveCase(state.port);
    // Also send queryActiveCase over WS as a fallback in case WS messages work.
    setTimeout(() => {
      log('DEBUG', 'sending queryActiveCase over WS');
      send({ type: 'queryActiveCase' });
    }, 300);
  };

  ws.onmessage = async (event) => {
    try {
      const msg: InboundMessage = JSON.parse(event.data as string);
      log('DEBUG', 'ws message received', { type: msg.type, caseId: msg.caseId ?? null });
      if (msg.type === 'activeCase' && msg.caseId && msg.title) {
        await setState({ activeCase: { caseId: msg.caseId, title: msg.title } });
        log('INFO', 'active case stored from WS', { caseId: msg.caseId });
      } else if (msg.type === 'noActiveCase') {
        await setState({ activeCase: null });
        log('INFO', 'active case cleared (noActiveCase from WS)');
      }
      notifyPopup({ type: 'stateChanged' });
    } catch (e) {
      log('ERROR', 'ws message parse error', { error: String(e) });
    }
  };

  ws.onclose = async (ev) => {
    clearTimeout(connectWatchdog);
    log('INFO', 'WebSocket closed', {
      code: ev.code,
      reason: ev.reason || null,
      wasClean: ev.wasClean,
      note: closeCodeHint(ev.code)
    });
    ws = null;
    if (!isContextValid()) {
      log('WARN', 'onclose: extension context invalidated — SW is shutting down, skipping state update');
      return;
    }
    try {
      await setState({
        connected: false,
        wsReadyState: 'CLOSED',
        lastDisconnectedAt: new Date().toISOString()
      });
      notifyPopup({ type: 'stateChanged' });
      scheduleReconnect();
    } catch (e) {
      log('WARN', 'onclose error (context invalidated)', { error: String(e) });
    }
  };

  ws.onerror = (ev) => {
    // The DOM WebSocket 'error' event carries no message/reason by design —
    // this fires for refused connections (VS Code not running / wrong port),
    // TLS issues, etc. The onclose handler that follows has the real detail
    // (code/reason), so we just record that an error happened here.
    const detail = `WebSocket error while ${readyStateName(ws?.readyState)} (url=${url})`;
    log('ERROR', detail);
    setState({ lastError: detail }).catch(() => { /* context may be gone */ });
    ws?.close();
  };
}

function closeCodeHint(code: number): string {
  switch (code) {
    case 1000: return 'normal closure';
    case 1001: return 'endpoint going away (e.g. VS Code closing/reloading)';
    case 1006: return 'abnormal closure — likely could not reach VS Code bridge server (not running / wrong port / firewall)';
    case 1015: return 'TLS handshake failure';
    default: return 'see https://developer.mozilla.org/docs/Web/API/CloseEvent/code';
  }
}

async function fetchActiveCase(port: number) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/state`);
    const data = await res.json() as { type: string; caseId?: string; title?: string };
    log('DEBUG', 'fetchActiveCase response', { type: data.type, caseId: data.caseId ?? null });
    if (data.type === 'activeCase' && data.caseId && data.title) {
      await setState({ activeCase: { caseId: data.caseId, title: data.title } });
      log('INFO', 'active case stored via HTTP', { caseId: data.caseId });
    } else if (data.type === 'noActiveCase') {
      await setState({ activeCase: null });
      log('INFO', 'no active case (HTTP response)');
    }
    notifyPopup({ type: 'stateChanged' });
  } catch (e) {
    log('WARN', 'fetchActiveCase failed', { error: String(e) });
  }
}

function scheduleReconnect() {
  // Alarms survive SW termination, but Chrome clamps their minimum period to
  // ~30-60s — too slow for a snappy retry. Also fire a same-process setTimeout
  // as a best-effort fast path; if the SW gets torn down before it fires, the
  // alarm below is the durable fallback that still guarantees a retry.
  if (!isContextValid()) return;
  chrome.alarms.create('reconnect', { delayInMinutes: 0.1 });
  setTimeout(() => { if (isContextValid()) connect(); }, 2000);
  getState().then(state => {
    const attempts = (state.reconnectAttempts ?? 0) + 1;
    setState({ reconnectAttempts: attempts });
    log('DEBUG', 'reconnect scheduled', { attempts, fastRetryMs: 2000 });
  });
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
    log('DEBUG', 'injecting content script', { tabId });
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
  log('DEBUG', 'alarm fired', { name: alarm.name });
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
    log('INFO', 'sendCapture', { name: outbound.name ?? null, type: outbound.type, source: outbound.source ?? null, contentLen: (outbound.content ?? '').length });
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
          log('INFO', 'sendCapture success', { name: outbound.name ?? null, captureCount: state.captureCount + 1 });
          notifyPopup({ type: 'stateChanged' });
          sendResponse({ ok: true });
        } else {
          log('WARN', 'sendCapture rejected by bridge', { error: data.error ?? 'unknown', name: outbound.name ?? null });
          sendResponse({ ok: false, error: data.error ?? 'Capture failed' });
        }
      } catch (e) {
        log('ERROR', 'sendCapture failed — bridge unreachable', { error: String(e) });
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
        const payload: OutboundMessage = {
          type: 'screenshot',
          source: tab.url ?? '',
          name: `screenshot-${captureTimestamp(now)}.png`,
          data: dataUrl,
          timestamp: now.toISOString()
        };
        log('INFO', 'captureScreenshot', { name: payload.name, tab: tab.url ?? null });
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
              log('INFO', 'captureScreenshot success', { name: payload.name });
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
