function $(id) {
    return document.getElementById(id);
}
function render(state) {
    const connected = state.connected;
    $('dot').className = 'dot' + (connected ? ' on' : '');
    $('status-label').textContent = connected ? 'Connected' : 'Disconnected';
    const captureBtn = $('capture-btn');
    captureBtn.disabled = !connected || !state.activeCase;
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
// Attach to window for inline HTML onclick handlers
window['captureTab'] = function () {
    chrome.runtime.sendMessage({ type: 'captureTab' }, (res) => {
        if (res?.ok) {
            feedback('Captured ✓');
        }
        else {
            feedback(res?.error ?? 'Capture failed', true);
        }
    });
};
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