function $(id) {
    return document.getElementById(id);
}
function render(state) {
    const connected = state.connected;
    $('dot').className = 'dot' + (connected ? ' on' : '');
    $('status-label').textContent = connected ? 'Connected' : 'Disconnected';
    const disabled = !connected || !state.activeCase;
    $('capture-page-btn').disabled = disabled;
    $('capture-sel-btn').disabled = disabled;
    $('capture-shot-btn').disabled = disabled;
    if (state.activeCase) {
        $('no-case').style.display = 'none';
        $('case-info').style.display = 'block';
        $('case-id').textContent = state.activeCase.caseId;
        $('case-title').textContent = state.activeCase.title;
        $('capture-count').textContent = `${state.captureCount} capture${state.captureCount !== 1 ? 's' : ''} this session`;
    }
    else {
        $('no-case').style.display = 'block';
        $('case-info').style.display = 'none';
    }
    $('port-input').placeholder = `Port (${state.port})`;
}
function feedback(msg, error = false) {
    const el = $('feedback');
    el.textContent = msg;
    el.style.color = error ? '#f14c4c' : '#4ec9b0';
    setTimeout(() => { el.textContent = ''; }, 2500);
}
function capturePageFull() {
    chrome.runtime.sendMessage({ type: 'captureTab' }, (res) => {
        if (res?.ok) {
            feedback('Captured ✓');
        }
        else {
            feedback(res?.error ?? 'Capture failed', true);
        }
    });
}
function captureSelectionOnly() {
    chrome.runtime.sendMessage({ type: 'captureSelection' }, (res) => {
        if (res?.ok) {
            feedback('Selection captured ✓');
        }
        else {
            feedback(res?.error ?? 'Selection capture failed', true);
        }
    });
}
function captureScreenshot() {
    chrome.runtime.sendMessage({ type: 'captureScreenshot' }, (res) => {
        if (res?.ok) {
            feedback('Screenshot captured ✓');
        }
        else {
            feedback(res?.error ?? 'Screenshot failed', true);
        }
    });
}
window['updatePort'] = function () {
    const val = parseInt($('port-input').value);
    if (!val || val < 1024 || val > 65535) {
        feedback('Invalid port', true);
        return;
    }
    chrome.runtime.sendMessage({ type: 'updatePort', port: val }, () => {
        feedback(`Port set to ${val}`);
    });
};
// Wire up capture buttons
document.addEventListener('DOMContentLoaded', () => {
    $('capture-page-btn').addEventListener('click', capturePageFull);
    $('capture-sel-btn').addEventListener('click', captureSelectionOnly);
    $('capture-shot-btn').addEventListener('click', captureScreenshot);
});
// Listen for state changes pushed from background
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'stateChanged') {
        chrome.runtime.sendMessage({ type: 'getState' }, (state) => render(state));
    }
});
// Load initial state
chrome.runtime.sendMessage({ type: 'getState' }, (state) => render(state));
export {};
//# sourceMappingURL=popup.js.map