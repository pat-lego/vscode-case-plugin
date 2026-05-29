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

## Thread Query Language

The **Thread Query** panel lets you run Splunk-style queries directly against the parsed threads from your loaded dumps. Open it via the **Thread Query** button in the investigation workspace header.

### Syntax

```
[filter] [| where filter] [| stats count [by field[, field2]]] [| top N]
```

Filters and `| where` clauses compose as AND. Multiple `| where` pipes narrow the result progressively.

---

### Filter fields

| Field | Matches against | Example |
|---|---|---|
| `thread` | Thread name (glob) | `thread=*http-nio*` |
| `state` | Thread state | `state=WAITING` |
| `frame` | Any frame in the stack (glob) | `frame=*HikariPool*` |
| `keyframe` | First non-JVM frame (glob) | `keyframe=*ServiceRegistry*` |
| `topframe` | Top-of-stack frame (glob) | `topframe=*Unsafe.park*` |
| `class` | Class extracted from keyframe | `class=*HikariPool*` |
| `package` | Package extracted from keyframe | `package=com.zaxxer*` |
| `method` | Method extracted from keyframe | `method=getConnection` |
| `stackdepth` | Number of frames in the stack | `stackdepth>=10` |

### Operators

| Operator | Works on | Example |
|---|---|---|
| `=` | String / glob | `state=BLOCKED`, `thread=*b2c*` |
| `!=` | String or number | `state!=RUNNABLE`, `stackdepth!=12` |
| `>` `>=` `<` `<=` | Number | `stackdepth>=10`, `stackdepth<5` |
| `IN (...)` | String list | `state IN (BLOCKED, WAITING)` |
| `AND` | Combine predicates | `state=WAITING AND thread=*b2c*` |
| `OR` | Either predicate | `state=BLOCKED OR state=WAITING` |

### Commands

| Command | What it does |
|---|---|
| `\| where <filter>` | Narrow results with an additional filter |
| `\| stats count by <field>` | Group and count by a field, sorted by count desc |
| `\| stats count by <f1>, <f2>` | Group by multiple fields |
| `\| stats count` | Return a single `{ count: N }` row |
| `\| top N` | Keep only the top N rows (use after stats) |

---

### Examples

#### Counting and grouping

```
# How many threads are in each state?
| stats count by state

# What are threads stuck on — top bottlenecks by keyframe?
| stats count by keyframe

# Break down by both state and keyframe
| stats count by state, keyframe

# Top 5 hottest code paths across all threads
| stats count by keyframe | top 5
```

#### Filtering by thread name and state

```
# All threads handling /content/b2c requests
thread=*b2c*

# b2c threads that are stuck waiting
thread=*b2c* AND state=WAITING

# b2c threads doing actual work (not idle or waiting)
thread=*b2c* AND state=RUNNABLE

# Exclude idle threads, then count what the rest are doing
state!=RUNNABLE | stats count by state
```

#### Querying stack frames

```
# Which threads are waiting on a database connection pool?
frame=*HikariPool*

# Threads stuck in OSGi service activation (Felix cold-start latch)
frame=*ServiceRegistry*

# Threads blocked waiting on an Elasticsearch result queue
frame=*ElasticResultRowAsyncIterator*

# Threads doing recursive JCR tree traversal
frame=*checkChildrenRecursively*

# Anything touching ConfigurationUtils — could be direct or indirect
frame=*ConfigurationUtils*
```

#### Piping filters (Splunk-style `| where`)

```
# WAITING threads that are also b2c requests
state=WAITING | where thread=*b2c*

# b2c threads, then narrow to those stuck in OSGi, then count what they're waiting on
thread=*b2c* | where frame=*ServiceRegistry* | stats count by keyframe

# Narrow by frame and thread name, then group
frame=*ContentFragmentUtils* | where thread=*b2c* | stats count by state
```

#### Counting with context

```
# How many b2c threads total?
thread=*b2c* | stats count

# How many b2c threads are hitting Elasticsearch?
thread=*b2c* AND frame=*ElasticResultRowAsyncIterator* | stats count

# Which OSGi call path is most congested?
# (distinguish by the frame that triggered the Felix lookup)
frame=*ServiceRegistry* | stats count by keyframe
```

#### Stack depth

```
# Threads with deep stacks (often stuck mid-call-chain)
stackdepth>=15

# Find shallow non-b2c threads (idle pool members)
state!=RUNNABLE AND stackdepth<5

# Distribution of stack depths across WAITING threads
state=WAITING | stats count by stackdepth
```

#### Combining everything

```
# Full triage: what are b2c threads doing, ranked by frequency?
thread=*b2c* | stats count by state, keyframe

# Identify the dominant bottleneck among non-idle b2c threads
thread=*b2c* AND state!=RUNNABLE | stats count by keyframe | top 3

# Confirm all WAITING threads share a single blocking point
state=WAITING AND frame=*ServiceRegistry* | stats count by keyframe

# Which packages are RUNNABLE threads spending time in?
thread=*b2c* AND state=RUNNABLE | stats count by package
```

---

### Row fields returned (no stats)

When no `stats` command is used, each matched thread produces one row with these fields:

| Field | Value |
|---|---|
| `thread` | Full thread name |
| `state` | `RUNNABLE` / `WAITING` / `TIMED_WAITING` / `BLOCKED` |
| `keyframe` | First non-JVM frame |
| `topframe` | Top-of-stack frame |
| `class` | Class name extracted from keyframe |
| `package` | Package extracted from keyframe |
| `method` | Method name extracted from keyframe |
| `stackdepth` | Number of frames in the stack |

---

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
