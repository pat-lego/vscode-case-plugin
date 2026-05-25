import { getState, setState, InboundMessage, OutboundMessage } from '../bridge/websocket.js';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

async function connect() {
  const state = await getState();
  const url = `ws://127.0.0.1:${state.port}`;

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(url);

  ws.onopen = async () => {
    await setState({ connected: true });
    notifyPopup({ type: 'stateChanged' });
    startPing();
  };

  ws.onmessage = async (event) => {
    try {
      const msg: InboundMessage = JSON.parse(event.data as string);
      if (msg.type === 'activeCase' && msg.caseId && msg.title) {
        await setState({ activeCase: { caseId: msg.caseId, title: msg.title } });
      } else if (msg.type === 'noActiveCase') {
        await setState({ activeCase: null });
      }
      notifyPopup({ type: 'stateChanged' });
    } catch { /* ignore */ }
  };

  ws.onclose = async () => {
    ws = null;
    await setState({ connected: false, activeCase: null });
    notifyPopup({ type: 'stateChanged' });
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

function startPing() {
  setInterval(() => {
    send({ type: 'ping' });
  }, 25000);
}

function send(msg: OutboundMessage): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

function notifyPopup(msg: object) {
  chrome.runtime.sendMessage(msg).catch(() => { /* popup may not be open */ });
}

// Keep service worker alive while connected
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') connect();
});

// Message handler for requests from popup and content scripts
chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, _sender, sendResponse) => {
  if (msg.type === 'getState') {
    getState().then(s => sendResponse(s));
    return true;
  }

  if (msg.type === 'sendCapture') {
    const outbound = msg.payload as OutboundMessage;
    const sent = send(outbound);
    if (sent) {
      getState().then(state => {
        setState({ captureCount: state.captureCount + 1 });
        notifyPopup({ type: 'stateChanged' });
      });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'Not connected to VS Code' });
    }
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
    // Inject content script capture into the active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) { sendResponse({ ok: false, error: 'No active tab' }); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'triggerCapture' }, (result) => {
        sendResponse(result ?? { ok: false, error: 'No response from content script' });
      });
    });
    return true;
  }
});

// Start connecting on load
connect();
