# Incident Investigator

Diagnose JVM incidents — thread dumps, logs, and failure patterns — without leaving VS Code.

Drop in thread dump files, capture Splunk output from Chrome, and the engine evaluates your data against a library of named failure patterns (*signatures*) instantly. No AI required on the hot path. Claude is available as an optional fallback for novel incidents.

---

## Features

### Investigation workspace

Open a case to get a three-panel workspace:

- **Evidence** — add thread dumps, logs, and screenshots. Each file is parsed immediately on drop. Drag panels to rearrange.
- **Notes** — freeform markdown for your investigation notes. The first heading (`# Title` or `## Title`) becomes the case title automatically.
- **Viewer** — open any evidence file in-pane with search (`Ctrl+F`). Multiple files open in stacked panes.

### Automatic pattern matching

When you add a thread dump the engine:

1. Detects format — jstack, IBM J9, or generic
2. Extracts signals: thread counts, blocked/waiting states, stack fingerprints, locked monitor addresses
3. Evaluates every loaded signature against the signals
4. Ranks matches by confidence (`HIGH` / `MED` / `LOW`) and shows the exact conditions that fired

Adding a second dump from later in the incident improves accuracy — the engine looks for patterns that *persist* across dumps.

### Browser extension bridge

A companion Chrome extension injects a **⬡ Capture** button on every page. Clicking it sends the page content (or your text selection) directly to the active investigation over a local WebSocket bridge. Splunk pages are detected automatically — the adapter extracts your search query and all result rows as TSV.

The bridge status dot in the VS Code header shows green when Chrome is connected.

### Signature library

Signatures are YAML files that define measurable conditions:

```yaml
id: db-pool-exhaustion
name: Database Connection Pool Exhaustion
conditions:
  - field: blockedThreadCount
    operator: gte
    value: 10
    description: "10+ threads in BLOCKED state"
  - field: persistentBlockedMonitors
    operator: gte
    value: 1
    description: "Monitor contention persists across dumps"
nextSteps:
  - "Check connection pool max-active setting"
  - "Fetch Splunk: JDBC connection timeout errors ±5min"
```

Four signatures ship bundled. Add your own to `investigator.signaturesPath` — they reload without restarting VS Code.

### Resolve and save patterns

When you find the root cause, click **Resolve**. The resolution panel shows your findings pre-populated in the Signature Builder. Check the conditions that were genuinely causal, add next steps for the next engineer, and save to your signature library.

### AI review (optional)

When no signature matches confidently, send the case to Claude for a full review — root cause, contributing factors, recommended next steps. Requires `investigator.claudeApiKey`. The prompt sends a compact signals summary, not raw dump text.

---

## Quick start

1. **Install** the extension from the VSIX or marketplace
2. **Configure** at minimum:
   ```json
   {
     "investigator.engineerInitials": "PL",
     "investigator.casePaths": ["/path/to/your/issues/folder"]
   }
   ```
3. **Open a case** — click the Incident Investigator icon in the activity bar, then **+** next to Open Cases
4. **Add evidence** — click **+ Add evidence files** and select thread dump `.txt` files
5. **Read findings** — expand any finding to see which signals triggered it

---

## Sidebar panels

| Panel | What it shows |
|---|---|
| **Open Cases** | Active investigations, sorted by last update. Click to open the workspace. Right-click for: Open in Finder, Send to AI, Run Static Analysis, Delete. |
| **Closed Cases** | Resolved investigations. Right-click to reopen. |
| **Signatures** | All loaded signatures (bundled + custom). Click to view, right-click to edit. |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `investigator.engineerInitials` | `XX` | Your initials — used in generated case IDs. |
| `investigator.casePaths` | `[]` | Folders to scan for cases on startup. New cases are written to the first path. Each subfolder named `CASE-ID/` with a matching `CASE-ID.md` is loaded as a case. |
| `investigator.signaturesPath` | *(none)* | Folder containing your custom YAML signature files. Custom signatures override bundled ones with the same ID. |
| `investigator.threadCountThreshold` | `500` | Thread count above which `threadCountAnomaly` is flagged. Adjust for your application's normal thread count. |
| `investigator.bridgePort` | `7734` | WebSocket port for the Chrome extension bridge. Change if 7734 is in use — must match the port in the browser extension popup. |
| `investigator.claudeApiKey` | *(none)* | Anthropic API key. Only needed for the Claude review feature. |
| `investigator.obsidianVaultPath` | *(none)* | Path to your Obsidian vault for case export. |

---

## Signature condition fields

The engine evaluates signatures by resolving named fields from the computed signal summary. All fields below are available in signature YAML `conditions`:

| Field | Type | Description |
|---|---|---|
| `totalThreadCount` | number | Max thread count across all dumps |
| `avgThreadCount` | number | Average thread count across dumps |
| `blockedThreadCount` | number | Max BLOCKED threads in any single dump |
| `waitingThreadCount` | number | Max WAITING/TIMED_WAITING threads in any single dump |
| `ioThreadCount` | number | Max threads with `java.io` / `sun.nio` / `java.net` frames |
| `gcThreadCount` | number | Max JVM GC subsystem threads |
| `dominantFingerprintCount` | number | Thread count of the most-common stack fingerprint |
| `dominantFingerprintRatio` | 0.0–1.0 | `dominantFingerprintCount / totalThreadCount` |
| `maxBlockedOnSingleMonitor` | number | Max threads waiting on any one monitor address |
| `topBlockedMonitorClass` | string | Java class of the most-contended monitor |
| `blockedMonitorCount` | number | Max distinct monitors with blocked waiters in any single dump |
| `persistentBlockedMonitors` | number | Monitor addresses that appear blocked in 2+ dumps |
| `threadCountAnomaly` | 0 or 1 | `1` if `totalThreadCount` > `threadCountThreshold` |
| `ioSaturationDetected` | 0 or 1 | `1` if average IO-thread ratio > 15% |

**Operators:** `gt` `gte` `lt` `lte` `eq` `contains` `matches` (regex, supports `(?i)` prefix for case-insensitive)

---

## Diagnostics and logging

All extension activity is written to the **Incident Investigator** output channel:

```
View → Output → "Incident Investigator"
```

Log format: `[HH:mm:ss.SSS] [LEVEL] [component] message  {"context":"json"}`

| Component | What it covers |
|---|---|
| `case-mgr` | Case lifecycle, disk reads/writes, save skips (shows `reason: readonly`) |
| `analysis` | Evidence type detection, thread dump parse metrics, signals summary, per-finding results |
| `bridge` | WebSocket connections, every HTTP and WS capture, active case broadcasts |
| `extension` | Activation, active-case changes |

If a title update or reopen is not persisting to disk, check the output for `case-mgr` → `save skipped` lines — they show the exact reason.

---

## Case file format

Cases are stored as Markdown files with YAML frontmatter:

```
<casePath>/
  CASE-20260524-PL-001/
    CASE-20260524-PL-001.md   ← frontmatter + summary
    ev-xxx.txt                ← evidence content (one file per item)
```

The extension reads cases from every path in `investigator.casePaths`. Plain Obsidian notes (no `case_id` in frontmatter) are loaded read-only and displayed in the Notes panel.

---

## Browser extension

Install the companion Chrome extension to capture data from the browser:

1. Build the browser extension: `npm run build` in `packages/browser-extension`
2. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, select `packages/browser-extension`
3. The **⬡ Capture** button appears on every page

The popup shows the active case and bridge connection status. The port must match `investigator.bridgePort`.

---

## Requirements

- VS Code 1.85 or later
- Node.js 18+ (for building from source)
