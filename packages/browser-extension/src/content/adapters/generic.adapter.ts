import { AdapterResult } from './splunk.adapter.js';

export function extract(label?: string): AdapterResult {
  const timestamp = new Date();
  const timeStr = `${pad(timestamp.getHours())}h${pad(timestamp.getMinutes())}`;
  const source = new URL(location.href).hostname;

  // Prefer selected text, fall back to main content area, fall back to body
  const selected = window.getSelection()?.toString().trim();

  let content: string;
  let name: string;

  if (selected && selected.length > 20) {
    content = [
      `# Selection from: ${location.href}`,
      `# Captured: ${timestamp.toISOString()}`,
      '',
      selected
    ].join('\n');
    name = `${source}-selection-${timeStr}.txt`;
  } else {
    const main =
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.querySelector('article') ||
      document.querySelector('#content') ||
      document.body;

    content = [
      `# Page: ${document.title}`,
      `# URL: ${location.href}`,
      `# Captured: ${timestamp.toISOString()}`,
      '',
      main?.innerText?.trim() ?? ''
    ].join('\n');
    name = label ? `${label}-${timeStr}.txt` : `${source}-${timeStr}.txt`;
  }

  return { name, content, source, mimeType: 'text/plain' };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
