import { BridgeState } from '../bridge/websocket.js';

function log(...args: unknown[]) {
  console.log('[II-popup]', ...args);
}

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function showDebug(msg: string) {
  const el = document.getElementById('debug');
  if (el) el.textContent = msg;
}

function render(state: BridgeState) {
  log('render', state);
  showDebug(`conn:${state.connected} case:${state.activeCase?.caseId ?? 'null'} port:${state.port}`);
  const connected = state.connected;
  $('dot').className = 'dot' + (connected ? ' on' : '');
  $('status-label').textContent = connected ? 'Connected' : 'Disconnected';
  ($('refresh-btn') as HTMLButtonElement).style.display = connected ? 'inline' : 'none';

  const disabled = !connected || !state.activeCase;
  ($('capture-page-btn') as HTMLButtonElement).disabled = disabled;
  ($('capture-sel-btn') as HTMLButtonElement).disabled = disabled;
  ($('capture-shot-btn') as HTMLButtonElement).disabled = disabled;

  if (state.activeCase) {
    $('no-case').style.display = 'none';
    $('case-info').style.display = 'block';
    $('case-id').textContent = state.activeCase.caseId;
    $('case-title').textContent = state.activeCase.title;
    $('capture-count').textContent = `${state.captureCount} capture${state.captureCount !== 1 ? 's' : ''} this session`;
  } else {
    $('no-case').style.display = 'block';
    $('case-info').style.display = 'none';
  }

  ($('port-input') as HTMLInputElement).placeholder = `Port (${state.port})`;
}

function feedback(msg: string, error = false) {
  const el = $('feedback');
  el.textContent = msg;
  el.style.color = error ? '#f14c4c' : '#4ec9b0';
  setTimeout(() => { el.textContent = ''; }, 2500);
}

function capturePageFull() {
  chrome.runtime.sendMessage({ type: 'captureTab' }, (res: { ok: boolean; error?: string }) => {
    if (res?.ok) {
      feedback('Captured ✓');
    } else {
      feedback(res?.error ?? 'Capture failed', true);
    }
  });
}

function captureSelectionOnly() {
  chrome.runtime.sendMessage({ type: 'captureSelection' }, (res: { ok: boolean; error?: string }) => {
    if (res?.ok) {
      feedback('Selection captured ✓');
    } else {
      feedback(res?.error ?? 'Selection capture failed', true);
    }
  });
}

function captureScreenshot() {
  chrome.runtime.sendMessage({ type: 'captureScreenshot' }, (res: { ok: boolean; error?: string }) => {
    if (res?.ok) {
      feedback('Screenshot captured ✓');
    } else {
      feedback(res?.error ?? 'Screenshot failed', true);
    }
  });
}

function updatePort() {
  const val = parseInt(($('port-input') as HTMLInputElement).value);
  if (!val || val < 1024 || val > 65535) { feedback('Invalid port', true); return; }
  chrome.runtime.sendMessage({ type: 'updatePort', port: val }, () => {
    feedback(`Port set to ${val}`);
  });
}

function refreshActiveCase() {
  chrome.runtime.sendMessage({ type: 'refreshActiveCase' }, () => {
    // Background sent queryActiveCase to VS Code; wait for stateChanged notification
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'getState' }, (state: BridgeState) => render(state));
    }, 400);
  });
}

window.addEventListener('error', (e) => {
  log('uncaught error', e.message, e.filename, e.lineno);
  showDebug(`JS ERROR: ${e.message} (${e.lineno})`);
});

document.addEventListener('DOMContentLoaded', () => {
  log('DOMContentLoaded — wiring buttons');
  $('capture-page-btn').addEventListener('click', capturePageFull);
  $('capture-sel-btn').addEventListener('click', captureSelectionOnly);
  $('capture-shot-btn').addEventListener('click', captureScreenshot);
  $('port-set-btn').addEventListener('click', updatePort);
  $('refresh-btn').addEventListener('click', refreshActiveCase);
  log('buttons wired');
});

// Listen for state changes pushed from background
chrome.runtime.onMessage.addListener((msg: Record<string, unknown>) => {
  log('onMessage', msg.type);
  if (msg.type === 'stateChanged') {
    chrome.runtime.sendMessage({ type: 'getState' }, (state: BridgeState) => {
      if (chrome.runtime.lastError) {
        log('getState error', chrome.runtime.lastError.message);
        showDebug('ERR: ' + chrome.runtime.lastError.message);
        return;
      }
      render(state);
    });
  }
});

// Load initial state; if connected but no active case, poll until we get one.
log('requesting initial state');
chrome.runtime.sendMessage({ type: 'getState' }, (state: BridgeState) => {
  if (chrome.runtime.lastError) {
    log('initial getState error', chrome.runtime.lastError.message);
    showDebug('ERR: ' + chrome.runtime.lastError.message);
    return;
  }
  log('initial state received', state);
  render(state);
  if (state.connected && !state.activeCase) {
    pollForCase();
  }
});

function pollForCase() {
  let attempts = 0;
  chrome.runtime.sendMessage({ type: 'refreshActiveCase' });
  const t = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'getState' }, (s: BridgeState) => {
      render(s);
      if (s.activeCase || !s.connected || ++attempts >= 8) clearInterval(t);
    });
  }, 800);
}
