export interface AdapterResult {
  name: string;
  content: string;
  source: string;
  mimeType: string;
}

export function matches(): boolean {
  return location.hostname.includes('splunk') ||
    document.title.toLowerCase().includes('splunk') ||
    !!document.querySelector('[data-view="splunk"]') ||
    !!document.querySelector('.splunk-view');
}

export function extract(): AdapterResult | null {
  const timestamp = new Date();
  const timeStr = `${pad(timestamp.getHours())}h${pad(timestamp.getMinutes())}`;

  // Try to get the search query
  const searchInput = (
    document.querySelector('input[data-component="search-input"]') ||
    document.querySelector('.search-bar-input') ||
    document.querySelector('[name="q"]')
  ) as HTMLInputElement | null;
  const query = searchInput?.value?.trim() ?? '';

  // Extract results table rows
  const rows = Array.from(document.querySelectorAll('tr.shared-resultstable-resultstablerow'));
  let content = '';

  if (rows.length > 0) {
    // Get headers
    const headers = Array.from(
      document.querySelectorAll('th.shared-resultstable-resultstableheader')
    ).map(th => th.textContent?.trim() ?? '');

    const lines: string[] = [];
    if (query) lines.push(`# Splunk Query: ${query}`);
    lines.push(`# Captured: ${timestamp.toISOString()}`);
    lines.push(`# Rows: ${rows.length}`);
    lines.push('');
    if (headers.length) lines.push(headers.join('\t'));

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim() ?? '');
      lines.push(cells.join('\t'));
    }
    content = lines.join('\n');
  } else {
    // Fallback: grab all visible text from results area
    const resultsPanel =
      document.querySelector('.splunk-results-table') ||
      document.querySelector('[data-role="results"]') ||
      document.querySelector('.shared-results-container') ||
      document.querySelector('main');

    if (!resultsPanel) return null;
    const text = resultsPanel.textContent?.trim() ?? '';
    if (!text) return null;

    content = [
      query ? `# Splunk Query: ${query}` : '# Splunk Capture',
      `# Captured: ${timestamp.toISOString()}`,
      '',
      text
    ].join('\n');
  }

  return {
    name: `splunk-${timeStr}.log`,
    content,
    source: 'splunk',
    mimeType: 'text/plain'
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
