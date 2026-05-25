export interface BridgeState {
  connected: boolean;
  activeCase: { caseId: string; title: string } | null;
  captureCount: number;
  port: number;
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
  port: 7734
};

export async function getState(): Promise<BridgeState> {
  const result = await chrome.storage.local.get('bridgeState');
  return { ...DEFAULT_STATE, ...(result.bridgeState as Partial<BridgeState> ?? {}) };
}

export async function setState(patch: Partial<BridgeState>): Promise<void> {
  const current = await getState();
  await chrome.storage.local.set({ bridgeState: { ...current, ...patch } });
}
