"use strict";
(() => {
  // src/popup/popup.ts
  function log(...args) {
    console.log("[II-popup]", ...args);
  }
  function $(id) {
    return document.getElementById(id);
  }
  function showDebug(msg) {
    const el = document.getElementById("debug");
    if (el) el.textContent = msg;
  }
  function render(state) {
    log("render", state);
    const lastConn = state.lastConnectedAt ? new Date(state.lastConnectedAt).toLocaleTimeString() : "never";
    const lastDisc = state.lastDisconnectedAt ? new Date(state.lastDisconnectedAt).toLocaleTimeString() : "never";
    showDebug(
      `conn:${state.connected} ws:${state.wsReadyState} case:${state.activeCase?.caseId ?? "null"} port:${state.port}
lastUp:${lastConn} lastDown:${lastDisc} reconnects:${state.reconnectAttempts}` + (state.lastError ? `
lastErr: ${state.lastError}` : "")
    );
    const connected = state.connected;
    $("dot").className = "dot" + (connected ? " on" : "");
    $("status-label").textContent = connected ? "Connected" : "Disconnected";
    $("refresh-btn").style.display = connected ? "inline" : "none";
    const disabled = !connected || !state.activeCase;
    $("capture-page-btn").disabled = disabled;
    $("capture-sel-btn").disabled = disabled;
    $("capture-shot-btn").disabled = disabled;
    if (state.activeCase) {
      $("no-case").style.display = "none";
      $("case-info").style.display = "block";
      $("case-id").textContent = state.activeCase.caseId;
      $("case-title").textContent = state.activeCase.title;
      $("capture-count").textContent = `${state.captureCount} capture${state.captureCount !== 1 ? "s" : ""} this session`;
    } else {
      $("no-case").style.display = "block";
      $("case-info").style.display = "none";
    }
    $("port-input").placeholder = `Port (${state.port})`;
  }
  function feedback(msg, error = false) {
    const el = $("feedback");
    el.textContent = msg;
    el.style.color = error ? "#f14c4c" : "#4ec9b0";
    setTimeout(() => {
      el.textContent = "";
    }, 2500);
  }
  function capturePageFull() {
    chrome.runtime.sendMessage({ type: "captureTab" }, (res) => {
      if (res?.ok) {
        feedback("Captured \u2713");
      } else {
        feedback(res?.error ?? "Capture failed", true);
      }
    });
  }
  function captureSelectionOnly() {
    chrome.runtime.sendMessage({ type: "captureSelection" }, (res) => {
      if (res?.ok) {
        feedback("Selection captured \u2713");
      } else {
        feedback(res?.error ?? "Selection capture failed", true);
      }
    });
  }
  function captureScreenshot() {
    chrome.runtime.sendMessage({ type: "captureScreenshot" }, (res) => {
      if (res?.ok) {
        feedback("Screenshot captured \u2713");
      } else {
        feedback(res?.error ?? "Screenshot failed", true);
      }
    });
  }
  function updatePort() {
    const val = parseInt($("port-input").value);
    if (!val || val < 1024 || val > 65535) {
      feedback("Invalid port", true);
      return;
    }
    chrome.runtime.sendMessage({ type: "updatePort", port: val }, () => {
      feedback(`Port set to ${val}`);
    });
  }
  function refreshActiveCase() {
    chrome.runtime.sendMessage({ type: "refreshActiveCase" }, () => {
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "getState" }, (state) => render(state));
      }, 400);
    });
  }
  window.addEventListener("error", (e) => {
    log("uncaught error", e.message, e.filename, e.lineno);
    showDebug(`JS ERROR: ${e.message} (${e.lineno})`);
  });
  document.addEventListener("DOMContentLoaded", () => {
    log("DOMContentLoaded \u2014 wiring buttons");
    $("capture-page-btn").addEventListener("click", capturePageFull);
    $("capture-sel-btn").addEventListener("click", captureSelectionOnly);
    $("capture-shot-btn").addEventListener("click", captureScreenshot);
    $("port-set-btn").addEventListener("click", updatePort);
    $("refresh-btn").addEventListener("click", refreshActiveCase);
    log("buttons wired");
  });
  chrome.runtime.onMessage.addListener((msg) => {
    log("onMessage", msg.type);
    if (msg.type === "stateChanged") {
      chrome.runtime.sendMessage({ type: "getState" }, (state) => {
        if (chrome.runtime.lastError) {
          log("getState error", chrome.runtime.lastError.message);
          showDebug("ERR: " + chrome.runtime.lastError.message);
          return;
        }
        render(state);
      });
    }
  });
  log("requesting initial state");
  chrome.runtime.sendMessage({ type: "getState" }, (state) => {
    if (chrome.runtime.lastError) {
      log("initial getState error", chrome.runtime.lastError.message);
      showDebug("ERR: " + chrome.runtime.lastError.message);
      return;
    }
    log("initial state received", state);
    render(state);
    if (state.connected && !state.activeCase) {
      pollForCase();
    }
  });
  setInterval(() => {
    chrome.runtime.sendMessage({ type: "getState" }, (state) => {
      if (chrome.runtime.lastError) return;
      render(state);
    });
  }, 1500);
  function pollForCase() {
    let attempts = 0;
    chrome.runtime.sendMessage({ type: "refreshActiveCase" });
    const t = setInterval(() => {
      chrome.runtime.sendMessage({ type: "getState" }, (s) => {
        render(s);
        if (s.activeCase || !s.connected || ++attempts >= 8) clearInterval(t);
      });
    }, 800);
  }
})();
