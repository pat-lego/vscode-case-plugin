# Incident Investigator

A VS Code extension + browser extension for diagnosing JVM/AEM incidents. You drop in thread dumps and captured log data, and the tool analyses them against a shared library of known failure patterns to surface findings instantly — no AI required on the hot path.

---

## Table of Contents

1. [How it works](#how-it-works)
2. [Architecture overview](#architecture-overview)
3. [Prerequisites](#prerequisites)
4. [Installation](#installation)
   - [Build the project](#1-build-the-project)
   - [Install the VS Code extension](#2-install-the-vs-code-extension)
   - [Load the browser extension in Chrome](#3-load-the-browser-extension-in-chrome)
   - [Configure VS Code settings](#4-configure-vs-code-settings)
   - [Set up your Obsidian vault](#5-set-up-your-obsidian-vault)
5. [Using the tool](#using-the-tool)
   - [Flow A: system is slow or crashed — start with thread dumps](#flow-a-system-is-slow-or-crashed--start-with-thread-dumps)
   - [Flow B: you have a known error — start with logs](#flow-b-you-have-a-known-error--start-with-logs)
   - [Capturing data from the browser](#capturing-data-from-the-browser)
   - [Requesting a Claude review](#requesting-a-claude-review)
   - [Resolving a case and saving a signature](#resolving-a-case-and-saving-a-signature)
   - [Exporting to Obsidian](#exporting-to-obsidian)
6. [Signatures](#signatures)
   - [What a signature is](#what-a-signature-is)
   - [Bundled signatures](#bundled-signatures)
   - [Writing your own signature](#writing-your-own-signature)
   - [Signature condition fields](#signature-condition-fields)
7. [Obsidian vault structure](#obsidian-vault-structure)
8. [Browser extension reference](#browser-extension-reference)
9. [VS Code settings reference](#vs-code-settings-reference)
10. [Project structure](#project-structure)
11. [Development](#development)

---

## How it works

When a system is slow, crashing, or throwing errors, you typically spend time manually correlating thread dumps with log data spread across multiple browser tabs. This tool collapses that workflow into a single investigation panel.

**The core idea:** thread dumps are the primary diagnostic surface. A thread dump tells you what every thread is doing at a moment in time — whether you have 800 threads all hitting the same endpoint, 40 threads blocked waiting for a database connection, or a deadlock. Logs are a secondary confirmation layer you pull only when the dump analysis is ambiguous.

**Pattern matching, not AI:** the tool maintains a library of *signatures* — named failure patterns defined as YAML conditions. When you add evidence, the engine evaluates every signature against your data and ranks matches by confidence. This is fast, deterministic, and free. Claude is available as an optional fallback for novel incidents where no signature matches.

**Shared knowledge:** signatures live in your Obsidian vault alongside completed cases. Every incident your team investigates either matches an existing signature or creates a new one. The library compounds over time and new engineers benefit immediately.

---

## Architecture overview

```
┌─ VS Code ─────────────────────────────────────────────┐
│                                                        │
│  Investigation Workspace (webview panel)               │
│  ┌─ Evidence ─────┐  ┌─ Findings ───────────────────┐ │
│  │ + Add files    │  │ [HIGH] Hot Endpoint           │ │
│  │ thread-dump    │  │ [MED]  DB Pool Contention     │ │
│  │ splunk.log     │  │ [ Request Full Review ]       │ │
│  └────────────────┘  └──────────────────────────────┘ │
│  ── Timeline ──────────────────────────────────────── │
│                                                        │
│  Sidebar: Cases list + Signature library               │
│                                                        │
│  Bridge server (WebSocket on port 7734) ◄──────────────┼──┐
└────────────────────────────────────────────────────────┘  │
                                                             │
┌─ Chrome browser extension ─────────────────────────────┐  │
│  Background service worker ── WebSocket client ────────┼──┘
│  Content script: ⬡ Capture button on every page        │
│  Popup: active case + capture button                   │
│  Page adapters: Splunk (structured), generic fallback  │
└────────────────────────────────────────────────────────┘

┌─ Obsidian vault (OneDrive) ────────────────────────────┐
│  cases/                                                │
│    CASE-20260524-PL-001/                               │
│      CASE-20260524-PL-001.md   ← narrative + findings  │
│      thread-dump-14h32.txt     ← raw attachments       │
│      splunk-14h35.log                                  │
│  signatures/                   ← shared team library   │
│    hot-endpoint.yaml                                   │
│    db-pool-exhaustion.yaml                             │
└────────────────────────────────────────────────────────┘
```

**Data flow when you add a thread dump:**

```
drop file → detect format (jstack / IBM J9 / generic)
          → parse: thread count, states, stack fingerprints, blocked monitors
          → extractSignals: aggregate across multiple dumps
          → matchSignatures: evaluate every signature's conditions
          → rank findings by confidence
          → display in findings panel
          → (optional) fetch logs from Splunk to confirm a finding
```

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 18 or later |
| npm | 9 or later |
| VS Code | 1.85 or later |
| Google Chrome | Any recent version |
| Obsidian | Any version (for vault export) |

---

## Installation

### 1. Build the project

```bash
git clone <repo-url>
cd incident-investigator
npm install
npm run build
```

This compiles all three packages: `core`, `vscode-extension`, and `browser-extension`.

### 2. Install the VS Code extension

VS Code extensions are distributed as `.vsix` files. To package the extension:

```bash
cd packages/vscode-extension
npx vsce package
```

This produces `incident-investigator-vscode-0.1.0.vsix`. Install it:

```bash
code --install-extension incident-investigator-vscode-0.1.0.vsix
```

Or in VS Code: open the Command Palette (`Cmd+Shift+P`), choose **Extensions: Install from VSIX**, and select the file.

> **During development** you can skip packaging. Open the repo in VS Code, then press `F5` to launch an Extension Development Host window with the extension loaded.

### 3. Load the browser extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `packages/browser-extension` folder

The extension icon will appear in your toolbar. Pin it for easy access.

> The extension needs to be reloaded from `chrome://extensions` whenever you rebuild it.

### 4. Configure VS Code settings

Open VS Code settings (`Cmd+,`) and search for **Incident Investigator**, or add these to your `settings.json`:

```json
{
  "investigator.engineerInitials": "PL",
  "investigator.obsidianVaultPath": "/Users/yourname/OneDrive/vault",
  "investigator.signaturesPath": "/Users/yourname/OneDrive/vault/signatures",
  "investigator.threadCountThreshold": 500,
  "investigator.bridgePort": 7734,
  "investigator.claudeApiKey": "sk-ant-..."
}
```

The minimum required settings are `engineerInitials` and `obsidianVaultPath`. Everything else has a sensible default.

See the [VS Code settings reference](#vs-code-settings-reference) for full details.

### 5. Set up your Obsidian vault

Create these folders inside your vault if they don't exist:

```
vault/
  cases/         ← created automatically when you export a case
  signatures/    ← put your YAML signature files here
```

Point `investigator.signaturesPath` at the `signatures/` folder. The bundled signatures ship with the extension — your custom signatures layer on top of them and override any with the same ID.

Open the vault in Obsidian. Cases exported from the tool will appear under `cases/` and link to signatures in `signatures/`.

---

## Using the tool

### Flow A: system is slow or crashed — start with thread dumps

This is the primary flow. You know something is wrong but you don't yet know why.

1. **Open a new investigation**
   - Click the Incident Investigator icon in the VS Code activity bar (left sidebar)
   - Click the **+** button next to Cases
   - Enter a short title (e.g. *API degradation on search endpoint*)
   - A case ID is generated: `CASE-20260524-PL-001`
   - The investigation workspace opens

2. **Add thread dumps**
   - Click **+ Add evidence files** in the Evidence panel
   - Select one or more thread dump `.txt` files
   - Findings appear immediately in the right panel

3. **Read the findings**
   - Each finding shows a confidence badge: `HIGH`, `MED`, or `LOW`
   - Click a finding to expand it and see exactly which signals triggered it
   - `HIGH` findings are almost always the root cause
   - `MED` findings are often contributing factors or downstream symptoms

4. **Add more dumps if available**
   - Adding a second dump from later in the incident improves accuracy
   - The engine looks for patterns that *persist* across dumps — those are more significant than one-time spikes
   - The timeline strip at the bottom shows when each dump was captured

5. **Confirm with logs if needed**
   - Each finding has a suggested next step like *Fetch Splunk: endpoint error rate ±5min*
   - Switch to your Splunk tab, run the query, click **⬡ Capture** in the browser extension
   - The log data lands in your evidence panel automatically

6. **Resolve the case** — see [Resolving a case](#resolving-a-case-and-saving-a-signature)

---

### Flow B: you have a known error — start with logs

You know the error message but don't know the cause.

1. **Open a new investigation** (same as above)
2. **Capture the log data from Splunk**
   - Run your Splunk query
   - Click **⬡ Capture** in the browser extension popup or on the page
   - The results land in the evidence panel
3. **The findings panel will suggest what to look for**
   - Log-based evidence alone won't match thread dump signatures, but the evidence panel records the log data and the timeline
   - The findings panel will show any partial matches and suggest *"collect a thread dump from this window"*
4. **Collect thread dumps from the same time window** and add them to confirm

---

### Capturing data from the browser

The browser extension injects a **⬡ Capture** button in the bottom-right corner of every page. Clicking it:

1. Detects what kind of page you're on
2. Extracts the relevant data (see adapters below)
3. Sends it to VS Code over the WebSocket bridge
4. The data lands in the active investigation's evidence panel

**Splunk pages:** the adapter extracts your current search query and all result rows. If the results table is not found, it falls back to the text content of the results area.

**Any other page:** the adapter captures your current text selection if you have one, otherwise the full text of the main content area. Select just the relevant part of a page before clicking Capture for a cleaner capture.

**Popup:** click the extension icon in the toolbar to see the active case and capture count. You can also trigger a capture from the popup without clicking the on-page button.

**If the bridge dot shows red (disconnected):** VS Code is not running, or the bridge port doesn't match. Check that VS Code is open and that `investigator.bridgePort` matches the port shown in the popup.

---

### Requesting a Claude review

When no signature matches confidently, or when you want a second opinion:

1. Click **Request Full Case Review (Claude)** at the bottom of the findings panel
2. A review panel opens showing the compressed context that will be sent (signals summary, not raw files)
3. You can edit the context before sending — add notes, remove irrelevant parts
4. Click **Run Review**
5. Claude responds with: Root Cause, Contributing Factors, Ruled Out, Recommended Next Steps

The review uses `claude-haiku-4-5-20251001` to minimise token cost. The context is a compact signals summary — never the raw thread dump text — so even a complex incident generates a small prompt.

**Requires** `investigator.claudeApiKey` to be set. If it's not set, the panel will tell you how to configure it.

You can also click **Ask Claude** on an individual finding to get a focused answer about that specific signature match.

---

### Resolving a case and saving a signature

When you've found the root cause:

1. Click **Resolve** in the investigation workspace header
2. The resolution panel opens showing the top findings from your case
3. Write a brief description of the root cause and what fixed it
4. Check **Open Signature Builder after resolving** if you want to save this pattern for future use
5. Click **Mark as Resolved**

**The Signature Builder** opens pre-populated with the conditions extracted from your evidence. Each condition has a checkbox:
- **Check** conditions that were genuinely causal
- **Uncheck** conditions that happened to be true but weren't the cause

This is the most important step for signature quality. An unchecked coincidental condition prevents false positives for future engineers.

Add next steps — what should the next engineer do when this fires? Be specific: *"Check whether Redis cache is reachable from this host"* is better than *"Check the cache"*.

Click **Save to Signature Library**. The signature is written to `investigator.signaturesPath` as a YAML file and immediately available for future investigations.

---

### Exporting to Obsidian

Click **Export** in the investigation workspace header at any time — not just at resolution.

The export creates:

```
vault/cases/CASE-20260524-PL-001/
  CASE-20260524-PL-001.md     ← main case file
  thread-dump-14h32.txt       ← raw thread dump
  thread-dump-14h45.txt       ← second dump
  splunk-14h35.log            ← log export
```

The markdown file uses Obsidian wiki-links:
- `[[thread-dump-14h32.txt]]` links to the raw dump in the same folder
- `[[hot-endpoint]]` links to the signature in `signatures/`
- `[[CASE-20260514-PL-003]]` links to a related prior case if you add it manually

In Obsidian's graph view, cases cluster around the signatures they matched. Over time this shows you which failure modes are most common in your system.

---

## Signatures

### What a signature is

A signature is a named, versioned failure pattern stored as a YAML file. It defines:

- **conditions** — measurable signals that must be present in the evidence (thread counts, ratios, blocked monitor counts, etc.)
- **indicators** — human-readable description of what the conditions mean
- **nextSteps** — what to do when this signature fires
- **relatedSignatures** — IDs of other signatures that often appear together

The engine evaluates every loaded signature against each investigation. A signature with all conditions met scores `high` confidence. Partial matches score `medium` or `low`. Only findings with at least one matched condition are shown.

### Bundled signatures

Four signatures ship with the extension:

| ID | Name | What it detects |
|---|---|---|
| `hot-endpoint` | Hot Endpoint / Request Flood | 50+ threads on the same stack fingerprint, 25%+ of thread pool on one endpoint |
| `db-pool-exhaustion` | Database Connection Pool Exhaustion | 10+ BLOCKED threads, monitor contention persisting across dumps |
| `full-gc-pause` | Full GC Pause / Stop-the-World | High thread count anomaly combined with 50+ WAITING threads |
| `deadlock` | Thread Deadlock | 2+ blocked monitors persisting across multiple dumps |

### Writing your own signature

Create a `.yaml` file in your `investigator.signaturesPath` folder. The filename should match the `id` field.

```yaml
id: redis-connection-timeout
name: Redis Connection Timeout
description: >
  Threads are blocked waiting for Redis connections, indicating the
  Redis pool is exhausted or the Redis host is unreachable.
version: "1.0"

conditions:
  - field: blockedThreadCount
    operator: gte
    value: 15
    description: "15+ threads in BLOCKED state"
  - field: dominantFingerprintCount
    operator: gte
    value: 30
    description: "30+ threads on same Redis connection stack"

indicators:
  - "Redis connection pool exhausted or host unreachable"
  - "Requests queuing behind unavailable cache layer"

nextSteps:
  - "Check Redis host connectivity from application server"
  - "Check Redis memory usage — eviction may be causing disconnects"
  - "Fetch Splunk: RedisConnectionException in ±5min window"
  - "Check Redis pool max-active setting"

relatedSignatures:
  - hot-endpoint
  - db-pool-exhaustion
```

Run **Reload Signatures** (click the refresh icon in the Signatures panel in the VS Code sidebar) to pick up new or edited files without restarting VS Code.

### Signature condition fields

Every field below is a named scalar computed by the signal extractor from the raw thread dump data. A condition in a signature YAML references one field by name. The engine resolves each field by direct property lookup on the computed signal summary — no code changes are needed to use any of these fields in a new or modified signature.

#### Thread count signals

| Field | Type | How it is computed |
|---|---|---|
| `totalThreadCount` | number | Maximum thread count observed across all dumps in the case |
| `avgThreadCount` | number | Average thread count across all dumps |
| `blockedThreadCount` | number | Maximum count of BLOCKED threads in any single dump |
| `waitingThreadCount` | number | Maximum count of WAITING or TIMED_WAITING threads in any single dump |
| `ioThreadCount` | number | Maximum count of threads with `java.io`, `sun.nio`, or `java.net` frames in any dump |
| `gcThreadCount` | number | Maximum count of JVM GC subsystem threads in any dump (threads named "GC task thread", "G1 Conc", "ZWorker", "Shenandoah", etc.) |

#### Stack fingerprint signals

| Field | Type | How it is computed |
|---|---|---|
| `dominantFingerprintCount` | number | Thread count of the single most-common stack fingerprint (threads sharing the same top 3 frames) |
| `dominantFingerprintRatio` | 0.0–1.0 | `dominantFingerprintCount / totalThreadCount` — fraction of threads on the same code path |

#### Lock and monitor signals

| Field | Type | How it is computed |
|---|---|---|
| `maxBlockedOnSingleMonitor` | number | Maximum number of threads waiting on any single monitor address across all dumps |
| `topBlockedMonitorClass` | string | Java class name of the most-contended monitor object (extracted from the `- waiting to lock <0xADDR> (a ClassName)` line in the dump) |
| `blockedMonitorCount` | number | Maximum count of distinct monitor addresses with at least one blocked waiter in any single dump |
| `persistentBlockedMonitors` | number | Count of monitor addresses that appear blocked in 2 or more separate dumps — requires at least two dumps; 0 if only one dump is provided |

#### Anomaly flags

These fields are `0` or `1` and are designed for use with the `eq` operator.

| Field | Type | How it is computed |
|---|---|---|
| `threadCountAnomaly` | 0 or 1 | `1` if `totalThreadCount` exceeds the configured `investigator.threadCountThreshold` (default 500), else `0` |
| `ioSaturationDetected` | 0 or 1 | `1` if the average ratio of IO threads to total threads exceeds 15%, else `0` |

---

### Condition operators

| Operator | Applies to | What it checks |
|---|---|---|
| `gt` | number | Field value is strictly greater than the condition value |
| `gte` | number | Field value is greater than or equal to the condition value |
| `lt` | number | Field value is strictly less than the condition value |
| `lte` | number | Field value is less than or equal to the condition value |
| `eq` | number or string | Field value equals the condition value exactly (use for 0/1 flags) |
| `contains` | string | Field value contains the condition value as a substring (case-sensitive) |
| `matches` | string | Field value matches the condition value as a JavaScript regular expression. Prefix with `(?i)` for case-insensitive matching: `value: "(?i)(hikari\|c3p0)"` |

---

## Obsidian vault structure

```
vault/
  cases/
    CASE-20260524-PL-001/
      CASE-20260524-PL-001.md   ← frontmatter + summary + findings + timeline
      thread-dump-14h32.txt
      splunk-14h35.log
    CASE-20260521-PL-002/
      ...
  signatures/
    hot-endpoint.yaml
    db-pool-exhaustion.yaml
    redis-connection-timeout.yaml   ← your custom signatures
    ...
```

**Case markdown frontmatter:**
```yaml
---
case_id: CASE-20260524-PL-001
title: "API degradation on search endpoint"
created: 2026-05-24T14:32:00Z
status: resolved
tags: [incident]
---
```

**Searching across cases:** in Obsidian, use `Cmd+Shift+F` to search all files. Searching for an error message, exception class, or endpoint name will surface all cases that involved it.

**Signature backlinks:** open any signature file in Obsidian and the backlinks panel shows every case that matched it. This gives you frequency data for each failure mode across your system's history.

---

## Browser extension reference

**Popup fields:**

| Element | Description |
|---|---|
| Dot (green/grey) | WebSocket connection to VS Code bridge |
| Active Case | Case ID and title of the current investigation in VS Code |
| Captures this session | Count of successful captures since VS Code was opened |
| Capture This Page | Triggers capture of the current active tab |
| Port field | Change the WebSocket port if it conflicts (must match `investigator.bridgePort`) |

**On-page button:**

The **⬡ Capture** button appears in the bottom-right of every page. It flashes green on success, red on failure. Common failures:

- *Not connected* — VS Code is not open or bridge server failed to start
- *No active case* — open an investigation in VS Code first
- *No response from content script* — try refreshing the page

**Splunk-specific behaviour:**

The extension detects Splunk by URL hostname or page structure. On a Splunk results page it captures:
1. Your current search query (from the search bar)
2. All rows from the results table as tab-separated values
3. Column headers

If the results table is empty or not found, it falls back to the visible text in the results area. Always run your full search before capturing — the extension captures what's currently rendered on screen.

**Generic page capture:**

On non-Splunk pages, if you have text selected, only the selection is captured. This is useful for capturing a specific log block, a table, or an error message without the surrounding page chrome. Select before clicking Capture.

---

## VS Code settings reference

| Setting | Default | Description |
|---|---|---|
| `investigator.engineerInitials` | `XX` | Your initials, used in case IDs. Set this first. |
| `investigator.obsidianVaultPath` | *(none)* | Full path to your Obsidian vault folder. Required for export. |
| `investigator.signaturesPath` | *(none)* | Path to folder containing YAML signature files. Falls back to bundled signatures if not set. |
| `investigator.threadCountThreshold` | `500` | Thread count above which `threadCountAnomaly` is flagged as 1. Adjust based on your application's normal thread count. |
| `investigator.bridgePort` | `7734` | WebSocket port for the browser extension bridge. Change if another process uses 7734. Must match the port in the browser extension popup. |
| `investigator.claudeApiKey` | *(none)* | Anthropic API key. Only needed if you use the Claude review feature. Get one at console.anthropic.com. |

To edit settings: `Cmd+,` → search *Incident Investigator*, or edit `settings.json` directly.

---

## Project structure

```
incident-investigator/
├── packages/
│   ├── core/                       ← shared TypeScript library
│   │   └── src/
│   │       ├── types/              ← Case, EvidenceItem, Signal, Signature, Finding
│   │       ├── parsers/
│   │       │   └── thread-dump/
│   │       │       ├── detector.ts     ← identifies jstack vs IBM J9 vs generic
│   │       │       ├── jstack.parser.ts
│   │       │       ├── ibm-j9.parser.ts
│   │       │       └── generic.parser.ts
│   │       ├── engine/
│   │       │   ├── signal-extractor.ts   ← aggregates signals across dumps
│   │       │   └── signature-matcher.ts  ← evaluates signature conditions
│   │       └── signatures/
│   │           └── loader.ts             ← reads YAML files from disk
│   │
│   ├── vscode-extension/           ← VS Code extension
│   │   └── src/
│   │       ├── extension.ts        ← activation, wires all services together
│   │       ├── services/
│   │       │   ├── case-manager.ts     ← persisted case state + event emitters
│   │       │   ├── signature-service.ts ← loads + saves signatures
│   │       │   ├── analysis-service.ts  ← orchestrates the analysis pipeline
│   │       │   ├── export-service.ts    ← writes Obsidian vault output
│   │       │   └── bridge-server.ts     ← WebSocket server for browser ext
│   │       ├── providers/
│   │       │   ├── sidebar.provider.ts       ← Cases tree view
│   │       │   ├── signature.provider.ts     ← Signatures tree view
│   │       │   └── investigation.webview.ts  ← main workspace panel
│   │       ├── panels/
│   │       │   ├── signature-builder.webview.ts  ← create/edit signatures
│   │       │   ├── case-resolution.webview.ts    ← resolve + signature prompt
│   │       │   └── claude-review.webview.ts      ← Claude review panel
│   │       └── commands/
│   │           ├── new-case.ts
│   │           └── export-case.ts
│   │
│   └── browser-extension/          ← Chrome extension (MV3)
│       ├── manifest.json
│       ├── popup/
│       │   └── popup.html
│       └── src/
│           ├── background/
│           │   └── index.ts        ← service worker, WebSocket client
│           ├── bridge/
│           │   └── websocket.ts    ← shared state + message types
│           ├── content/
│           │   ├── index.ts        ← injects capture button
│           │   └── adapters/
│           │       ├── splunk.adapter.ts   ← Splunk-specific extraction
│           │       └── generic.adapter.ts  ← selection / main content fallback
│           └── popup/
│               └── popup.ts
│
└── signatures/                     ← bundled signature library (ships with extension)
    ├── hot-endpoint.yaml
    ├── db-pool-exhaustion.yaml
    ├── full-gc-pause.yaml
    └── deadlock.yaml
```

---

## Development

**Build everything:**
```bash
npm install
npm run build
```

**Typecheck without building:**
```bash
npm run typecheck
```

**Build only core (required before building the extension):**
```bash
npx tsc --project packages/core/tsconfig.json
```

**Run the VS Code extension in development mode:**
1. Open the repo in VS Code
2. Press `F5` — this opens an Extension Development Host window
3. Changes to TypeScript files require a rebuild (`npm run build`) and reload (`Ctrl+R` in the Extension Development Host)

**Adding a new page adapter to the browser extension:**

1. Create `packages/browser-extension/src/content/adapters/your-tool.adapter.ts`
2. Export a `matches(): boolean` function that detects the page
3. Export an `extract(): AdapterResult | null` function that pulls the data
4. Import and call it in `packages/browser-extension/src/content/index.ts` before the generic fallback

**Running tests:**
```bash
npm test --workspace packages/core
```

Tests cover the thread dump parsers (jstack, IBM J9, generic), the signal extractor, the signature matcher (all operators, confidence scoring, field resolution), and the signature loader IO (write a YAML file to a temp directory, read it back, verify it runs through the matcher). Run them after any change to the core package.

**Adding a new signature condition field:**

The signature matcher is fully data-driven — it resolves fields by direct property lookup on the `ThreadDumpSummary` object. To add a new signal field:

1. Add a scalar (`number` or `string`) property to `ThreadDumpSummary` in `packages/core/src/engine/signal-extractor.ts`
2. Compute its value in `extractSignals()` and `emptySummary()` in the same file
3. Rebuild core: `npx tsc --project packages/core/tsconfig.json`
4. Use the new field name in any YAML signature condition — no changes to `signature-matcher.ts` are needed

The key constraint: only primitive scalar fields (`number`, `string`) are resolvable by signatures. Array fields on the summary (used internally for evidence building) are silently ignored by the matcher.

**Sharing signatures with the team:**

Signatures in the Obsidian vault (`signatures/` folder) are synced via OneDrive. When you save a signature from the Signature Builder, it writes to `investigator.signaturesPath` which should point to the vault's `signatures/` folder. Other engineers pick up the new file on their next VS Code reload or by clicking **Reload Signatures** in the sidebar.

---

## Debugging and logging

### VS Code extension logs

All extension activity is written to the **Incident Investigator** output channel. Open it via:

```
View → Output → select "Incident Investigator" from the dropdown
```

Log format:
```
[HH:mm:ss.SSS] [LEVEL] [component] message  {"context":"json"}
```

Components and what they log:

| Component | What it covers |
|---|---|
| `extension` | Activation, active-case changes |
| `case-mgr` | Case create/read/update/delete, disk reads and writes, active-case transitions |
| `analysis` | Evidence type detection, thread dump parsing, signal extraction, signature matching, per-finding results |
| `bridge` | Bridge server start, WebSocket connections and disconnections, every capture (HTTP and WS) |

Log levels:
- `INFO ` — key state transitions (case created, evidence added, finding matched, client connected)
- `DEBUG` — fine-grained data flow (signals summary, per-condition evaluation, save path chosen)
- `WARN ` — recoverable issues (disk write failed, capture rejected)
- `ERROR` — unrecoverable failures (also written to the developer console)

**Tip:** filter the output by component — e.g. type `case-mgr` in the output channel filter box to see only case persistence events.

### Browser extension logs

Open Chrome DevTools on the background service worker:

```
chrome://extensions → Incident Investigator → "Inspect views: service worker"
```

All background activity is logged to the service worker's console with prefix `[II-bg]`:
```
[HH:mm:ss.SSS] [LEVEL] [II-bg] message {"context":"json"}
```

Key events logged:
- `WebSocket connected / closed` — bridge connectivity
- `active case stored / cleared` — when the active case changes
- `sendCapture` — every capture attempt with payload size and result
- `captureScreenshot` — screenshot captures
- `alarm fired` — keep-alive and reconnect alarms

Content script logs (logged from each tab that has the extension loaded) use prefix `[II-content]`:
```
chrome://extensions → Incident Investigator → click the "Inspect" link for a specific tab
```
Or open the regular DevTools (`F12`) on the page you captured from.

Content script events: adapter selection, content extraction size, and send result.

### Correlating logs across components

To trace a single capture end-to-end:

1. In the browser console, find the `sendCapture` log line — note the `name` field (e.g. `splunk-14h32.log`)
2. In VS Code output, find `POST /capture` with the same `name`
3. Below that, find `processEvidence` and `parsed thread dump` (if it was a thread dump)
4. Then `signals summary` — this shows the computed values the signatures evaluated against
5. Then one `finding` line per matched signature (with confidence score)
6. Finally `processEvidence done` with the total finding count

If a capture is not appearing in VS Code:
- Check the browser console for `sendCapture failed — bridge unreachable` (VS Code bridge is not running)
- Check the VS Code output for `POST /capture` with an error
- Check `case-mgr` for `save skipped` with `reason: readonly` (the case may have been loaded read-only)
