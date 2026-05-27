import * as splunk from './adapters/splunk.adapter.js';
import * as generic from './adapters/generic.adapter.js';
import { captureTimestamp } from '../utils/capture-name.js';

// Prevent double-registration if the script is injected more than once.
if ((window as unknown as Record<string, unknown>)['__ii_loaded']) {
  throw new Error('II content script already loaded');
}
(window as unknown as Record<string, unknown>)['__ii_loaded'] = true;

function log(msg: string, ctx?: Record<string, unknown>) {
  const ctxStr = ctx && Object.keys(ctx).length > 0 ? ' ' + JSON.stringify(ctx) : '';
  console.log(`[II-content] ${msg}${ctxStr}`);
}

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

  btn.addEventListener('click', () => {
    capture().then(ok => {
      btn.textContent = ok ? '✓ Sent' : '✗ Failed';
      btn.style.color = ok ? '#4ec9b0' : '#f14c4c';
      setTimeout(() => { btn.textContent = '⬡ Capture'; btn.style.color = '#cccccc'; }, 1800);
    });
  });

  document.body.appendChild(btn);
}

async function capture(): Promise<boolean> {
  log('capture triggered', { url: location.href, adapter: splunk.matches() ? 'splunk' : 'generic' });
  const result = splunk.matches() ? splunk.extract() : generic.extract();
  if (!result) return false;
  log('adapter extracted', { name: result.name, contentLen: result.content.length, mimeType: result.mimeType });

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
      (res: { ok: boolean }) => {
        log('capture sent', { ok: res?.ok ?? false, name: result.name });
        resolve(res?.ok ?? false);
      }
    );
  });
}

chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, _sender, sendResponse) => {
  if (msg.type === 'triggerCapture') {
    log('triggerCapture message received');
    capture().then(ok => sendResponse({ ok }));
    return true;
  }

  if (msg.type === 'triggerSelectionCapture') {
    log('triggerSelectionCapture', { selectionLen: window.getSelection()?.toString().trim().length ?? 0 });
    const selection = window.getSelection()?.toString().trim() ?? '';
    if (selection.length < 10) {
      sendResponse({ ok: false, error: 'Nothing selected' });
      return true;
    }
    const hostname = location.hostname;
    const now = new Date();
    const header = `Source: ${location.href}\nCaptured: ${now.toISOString()}\n\n`;
    const payload = {
      type: 'capture' as const,
      source: hostname,
      name: `${hostname}-selection-${captureTimestamp(now)}.txt`,
      content: header + selection,
      timestamp: now.toISOString()
    };
    chrome.runtime.sendMessage({ type: 'sendCapture', payload }, (res: { ok: boolean; error?: string }) => {
      sendResponse(res ?? { ok: false, error: 'No response' });
    });
    return true;
  }
});

injectButton();
