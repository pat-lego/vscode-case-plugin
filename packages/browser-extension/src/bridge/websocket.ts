export interface BridgeState {
  connected: boolean;
  activeCase: { caseId: string; title: string } | null;
  captureCount: number;
  port: number;
  // Diagnostics — not used for connection logic, only surfaced in the popup
  // debug line to help explain mismatches with the VS Code status bar (which
  // has a 60s grace period after last activity before it flips to disconnected).
  wsReadyState: string;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastError: string | null;
  reconnectAttempts: number;
}

export interface OutboundMessage {
  type: 'capture' | 'screenshot' | 'ping' | 'queryActiveCase';
  source?: string;
  name?: string;
  content?: string;
  data?: string;
  mimeType?: string;
  timestamp?: string;
}

export interface InboundMessage {
  type: 'activeCase' | 'noActiveCase' | 'captureAck' | 'pong' | 'error';
  caseId?: string;
  title?: string;
  name?: string;
  message?: string;
}

// Stored in chrome.storage.local — shared between background, popup, content
export const DEFAULT_STATE: BridgeState = {
  connected: false,
  activeCase: null,
  captureCount: 0,
  port: 7734,
  wsReadyState: 'CLOSED',
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastError: null,
  reconnectAttempts: 0
};

export async function getState(): Promise<BridgeState> {
  const result = await chrome.storage.local.get('bridgeState');
  return { ...DEFAULT_STATE, ...(result.bridgeState as Partial<BridgeState> ?? {}) };
}

// setState is read-modify-write, not atomic. The background script fires
// several setState() calls back-to-back with no await between them (e.g.
// ws.onopen setting `connected: true` and ws.onmessage setting `activeCase`
// land in the same tick, since VS Code pushes the active-case payload the
// instant it accepts the connection). Without serialization, two concurrent
// calls can both read the same pre-write snapshot, and whichever write
// finishes last silently discards the other's change — observed in practice
// as `connected` reverting back to false moments after the WS actually opened,
// even though the socket stayed healthy. Chain every call through one queue
// so each read-modify-write completes before the next one starts.
let stateQueue: Promise<void> = Promise.resolve();

export function setState(patch: Partial<BridgeState>): Promise<void> {
  stateQueue = stateQueue.then(async () => {
    const current = await getState();
    await chrome.storage.local.set({ bridgeState: { ...current, ...patch } });
  });
  return stateQueue;
}
