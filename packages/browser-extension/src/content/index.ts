import * as splunk from './adapters/splunk.adapter.js';
import * as generic from './adapters/generic.adapter.js';

// Inject a floating capture button on supported pages
function injectButton() {
  if (document.getElementById('ii-capture-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'ii-capture-btn';
  btn.textContent = '⬡ Capture';
  btn.title = 'Send page data to active investigation in VS Code';
  Object.assign(btn.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '999999',
    padding: '6px 12px',
    background: '#1e1e1e',
    color: '#cccccc',
    border: '1px solid #444',
    borderRadius: '4px',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '12px',
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
    userSelect: 'none'
  });

  btn.addEventListener('click', () => triggerCapture());
  document.body.appendChild(btn);

  // Flash feedback on btn
  function flash(ok: boolean) {
    btn.textContent = ok ? '✓ Sent' : '✗ Failed';
    btn.style.color = ok ? '#4ec9b0' : '#f14c4c';
    setTimeout(() => { btn.textContent = '⬡ Capture'; btn.style.color = '#cccccc'; }, 1800);
  }

  btn.addEventListener('click', () => {
    capture().then(ok => flash(ok));
  });
}

async function capture(): Promise<boolean> {
  const result = splunk.matches() ? splunk.extract() : generic.extract();
  if (!result) return false;

  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      {
        type: 'sendCapture',
        payload: {
          type: 'capture',
          source: result.source,
          name: result.name,
          content: result.content,
          mimeType: result.mimeType,
          timestamp: new Date().toISOString()
        }
      },
      (res: { ok: boolean }) => resolve(res?.ok ?? false)
    );
  });
}

// Listen for trigger from background (popup button)
function triggerCapture() {
  capture().then(ok => {
    if (!ok) {
      showToast('Not connected to VS Code. Open an investigation first.');
    }
  });
}

chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, _sender, sendResponse) => {
  if (msg.type === 'triggerCapture') {
    capture().then(ok => sendResponse({ ok }));
    return true;
  }
});

function showToast(message: string) {
  const toast = document.createElement('div');
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '60px',
    right: '20px',
    zIndex: '999999',
    padding: '8px 14px',
    background: '#1e1e1e',
    color: '#f14c4c',
    border: '1px solid #f14c4c44',
    borderRadius: '4px',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)'
  });
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// Only inject button — don't auto-capture on load
injectButton();
