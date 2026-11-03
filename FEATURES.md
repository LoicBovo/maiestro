# Maiestro — Functionality List

Living document: the inventory of every user-facing and integration feature of
Maiestro. Update it whenever a feature is added, changed, or removed, so it
stays the reference for what must keep working (regression checklist) and for
scoping new work.

How to use it:

- Each feature has a stable ID (`AREA-NN`). Reference IDs in commits, PRs, and
  issues ("this changes AGT-03").
- **Status**: `working` = verified at least once end-to-end; `unverified` =
  implemented but never confirmed; `planned` = not implemented yet.
- Before releasing or merging a significant change, walk the *Verification*
  column of the affected area — it is the regression checklist.
- After adding a feature, append a row (and a way to verify it).

Tools: `claude` (Claude Code) and `vibe` (Mistral Vibe), run by the daemon on
behalf of the GUI. Modes: `headless` (pipes, parsed events) and `terminal`
(interactive CLI embedded in the GUI).

---

## 1. Agent lifecycle (AGT)

| ID  | Feature | Details | Status | Verification |
| --- | --- | --- | --- | --- |
| AGT-01 | Spawn agent | Tool (`claude`/`vibe`) + free-text task + working directory (defaults to the project's main folder, then home) + optional project (null = solo). Task required. | working | `npm run smoke`; GUI "+ New agent" |
| AGT-02 | Agent name | Optional user label (trimmed, max 80 chars, stored on the agent, shown instead of the task everywhere). Rename and clear at any time; empty string clears. | working | Rename from detail pane; notification shows the name |
| AGT-03 | Branch tracking | Git branch of the agent's cwd recorded at spawn time (null when not a repo); shown on the agent card. | working | Spawn in a git repo, check the card |
| AGT-04 | Status lifecycle | `running → blocked → done / error / stopped`; transitions persisted with `endedAt`; stale `running`/`blocked` agents are re-marked `stopped` ("daemon restarted") on daemon restart. | working | Kill the app mid-run, relaunch, agent shows `stopped` |
| AGT-05 | Stop agent | Kills the process (SIGTERM then SIGKILL), cancels pending permission requests, status → `stopped`. | working | Stop button on a running agent |
| AGT-06 | Resume agent | Resumes the agent's latest CLI session in place (`--resume <sessionId>` + follow-up message, default "continue") instead of re-running the original task; the vibe stream records the session id per run, and vibe agents with none recorded fall back to the newest vibe session logged for their cwd. Options can be overridden (e.g. new vibe policy). | working | Resume a vibe agent; it remembers the earlier turn |
| AGT-07 | Remove agent | Stops it if needed (confirm dialog when running/blocked), deletes the record and its events from the GUI. | working | Close button on a card |
| AGT-08 | Last message | Latest meaningful output of the agent (assistant text, final result, TUI tail) mirrored on the agent record for at-a-glance status in the list. | working | Watch the card while an agent runs |

## 2. Headless adapters (ADP)

| ID  | Feature | Details | Status | Verification |
| --- | --- | --- | --- | --- |
| ADP-01 | Claude headless | `claude -p <task> --output-format stream-json --verbose`; parses `system` (session id), `assistant` messages + tool_use, `user` tool_results, `result` (done/error + `total_cost_usd`). Non-JSON lines logged. | working | `npm run smoke` (Claude path verified end-to-end) |
| ADP-02 | Claude permission flow | `--permission-prompt-tool mcp__maiestro__permission_decision` + MCP shim (generated into `<dataDir>/bin/` at startup); shim POSTs to `/internal/permission-request`, request held open, agent → `blocked`; Approve/Deny in GUI resolves it; 10-min timeout auto-denies; stop/exit cancels. | working | Smoke: spawn → blocked → approve → done |
| ADP-03 | Approve / Deny in GUI | Detail pane shows pending tool name + input; Approve allows with same input; Deny sends a message (editable). | working | Smoke + GUI |
| ADP-04 | Vibe headless | `vibe -p <task> --output streaming --workdir --agent <policy> --max-turns`; JSONL parsed, non-JSON lines tolerated; **stdin ignored** (vibe blocks on an open pipe). | working | `npm run smoke` (vibe path) |
| ADP-05 | Vibe approval policies | `ask \| plan \| accept-edits \| smart-approve \| auto-approve` selectable per agent; headless vibe auto-denies when the policy asks. | working | Spawn with `ask`, watch a denial |
| ADP-06 | Vibe blocked semantics | Denied approval surfaces as a `tool_denied` failed effect → agent marked `blocked` with a log entry (policy named). Unblock = stop/resume with a different policy. | working | Smoke: vibe blocked → stop |
| ADP-07 | Cost tracking | Claude reports `total_cost_usd` on `result`; shown in detail pane. | working | Detail pane of a finished claude agent |

## 3. Terminal mode (PTY interactive agents) (TRM)

| ID  | Feature | Details | Status | Verification |
| --- | --- | --- | --- | --- |
| TRM-01 | Embedded terminal | Agent's interactive CLI (no `-p`) runs in a PTY rendered with xterm.js in the detail pane; keystrokes sent back; resizable. | working | Spawn in terminal mode, type a follow-up prompt |
| TRM-02 | Scrollback / late attach | Daemon keeps up to 256k chars of scrollback per terminal with a monotonic sequence number; attaching returns the buffer + seq, live chunks dedupe against it. | working | Open the detail pane mid-run |
| TRM-03 | CLI resolution | CLI resolved to an absolute path (PATH + `~/.local/bin`) so it works when Electron has a sparse PATH; node-pty `spawn-helper` exec bit repaired once at startup. | working | Launch app from Finder |
| TRM-04 | Vibe TUI status markers | Vibe's OSC 7501 markers mapped to turn states: `state=working` → `running` (turn started), `state=done` → `done`, `state=error` → `error`, `state=blocked` / `blocked:kind=<permission|question>` → `blocked` (CLI stays open; the user answers in the embedded terminal). | working | Terminal-mode vibe: run a turn, see `done`; with the `ask` policy, see `blocked` + notification |
| TRM-05 | Claude TUI status via hooks | Claude TUI emits no markers; per-spawn `--settings` hooks (SessionStart, UserPromptSubmit, Notification, PostToolUse, Stop) POST to `/internal/agent-hook`; mapped to session id, turn running, permission→`blocked`, tool ran→`running`, turn complete→`done`. Settings file removed on exit. | working | Terminal-mode claude: run a turn, watch status change |
| TRM-06 | Status mirroring | Last visible TUI line (ANSI stripped, ≥3 chars, throttled to 500 ms) mirrored into `lastMessage` so the main window shows live progress. | working | Card updates while terminal agent runs |
| TRM-07 | Terminal exit handling | Exit 0 → `done`, non-zero → `error` (unless already stopped by the user). | working | Exit the CLI in the pane |
| TRM-08 | Pinned `shell` panes | One plain login shell (the user's `$SHELL`) per project — rendered like an agent with the label `shell`, opened in the project's main folder — plus one solo pane at the process cwd (home when the app launches with cwd `/`). All sit at the top of the agent list, auto-started with the daemon, and cannot be closed or renamed (daemon refuses remove/rename). A project gets its pane on creation and loses it on deletion. Each pane reopens where it was left — the live shell cwd is polled every 5 s (lsof / /proc) and persisted. Exited shell restarts via "Restart shell" (resume with no session). | working | Launch the app, `cd` in the shell pane, quit and relaunch |

## 4. Projects (PRJ)

| ID  | Feature | Details | Status | Verification |
| --- | --- | --- | --- | --- |
| PRJ-01 | Projects | User-defined pool: name + ordered list of working directories (`dirs[0]` = main folder). Used as cwd default and for PR scanning. Legacy single-cwd entries migrated to `dirs`. | working | Create a project with 2 folders |
| PRJ-02 | Create / delete projects | Create from the sidebar (name + folder picker, multiple folders); delete reassigns its agents to solo. Agents can also run solo (no project). | working | Sidebar "+ New project", delete a project with agents |
| PRJ-03 | Project filters | Sidebar: "All agents", "Solo", and each project, with agent counts; selecting filters the agent list. | working | Click through the sidebar |

## 5. Pull requests (PRS)

| ID  | Feature | Details | Status | Verification |
| --- | --- | --- | --- | --- |
| PRS-01 | Open PRs pane | For the selected project, lists open PRs of every project dir via `gh pr list` (limit 50): repo, number, title, branch, author, draft state, age; deduped across dirs; per-dir failures shown as errors (never thrown). `gh` found via extended PATH (homebrew locations). | working | Select a project with GitHub checkouts |
| PRS-02 | Auto refresh | Pane refreshes when the project selection changes and when the number of finished agents of the project changes (a fresh agent may have opened a PR); manual Refresh button. | working | Finish an agent in a project, watch the pane |
| PRS-03 | Open in browser | Clicking a PR opens it via the OS browser; only `http:`/`https:` URLs are ever opened externally. | working | Click a PR row |

## 6. Notifications (NTF)

| ID  | Feature | Details | Status | Verification |
| --- | --- | --- | --- | --- |
| NTF-01 | OS notifications | On transitions to `blocked`, `done`, `error`: title includes the project name ("solo" fallback), body identifies the agent by name (or truncated task). Clicking a notification shows/focuses the window. Delivery is robust to denied OS permissions: `Notification.isSupported()` falls back to console, and on macOS the Dock icon bounces when the window is not focused (critical until activation for `blocked`, once otherwise). | working | Let an agent finish in the background |
| NTF-02 | Standalone daemon notifications | `npm run daemon` always logs to console; `MAIESTRO_OS_NOTIFY=1` additionally fires macOS notifications. | working | Run the standalone daemon |

## 7. GUI (GUI)

| ID  | Feature | Details | Status | Verification |
| --- | --- | --- | --- | --- |
| GUI-01 | Layout | Dark theme, sidebar (projects) \| agent list \| detail pane \| PRs pane. Empty states when no agents / no selection / no project for PRs. | working | `npm run dev` |
| GUI-02 | Agent cards | One row per agent: status badge, tool, name, project/solo, branch, task, last message; close button with confirm when running/blocked. | working | List view |
| GUI-03 | Filter bar | Filter the list by tool (claude/vibe) and status (running/blocked/done/error/stopped), combined with the sidebar project filter. | working | FilterBar |
| GUI-04 | Detail pane | Task, name (inline rename), status, project, cwd, branch, start/end time, duration, cost, session id; live event log (messages, tool uses/results, blocked, done, error, logs) auto-scrolling unless the user scrolled up. | working | Select an agent |
| GUI-05 | Spawn dialog | Modal: tool select, project select (pre-set to the current sidebar filter, solo default), name, task textarea, cwd with native folder picker, mode (headless/terminal), vibe policy + maxTurns (vibe only). | working | "+ New agent" |
| GUI-06 | Live updates | Agents, projects, and events are pushed from the daemon over IPC (`agents:changed`, `projects:changed`, `agent:event`, `terminal:data`); no polling. Selection preserved across pushes. | working | Watch two agents run |
| GUI-07 | Resume form | Detail pane offers Stop, and Resume (optional follow-up message; vibe: policy + maxTurns pickers), with per-agent busy state; resume errors show inline. | working | Resume a vibe agent |

## 8. Daemon, persistence, API (DAE)

| ID  | Feature | Details | Status | Verification |
| --- | --- | --- | --- | --- |
| DAE-01 | Daemon core | UI-agnostic orchestrator (registry + process supervision + events + permissions) running inside the Electron main process; the standalone CLI runs the same daemon headless. | working | `npm run daemon` |
| DAE-02 | Persistence | JSON files under `~/.maiestro` (override with `MAIESTRO_HOME`): `agents.json`, `projects.json`, `events.jsonl` (append-only, per agent, removed with the agent), `config.json`. In-memory registry is the source of truth, persisted on every change. | working | Restart the app, state survives |
| DAE-03 | HTTP API | Bound to `127.0.0.1` (first free port from 49377), bearer-token auth (token in `config.json`). Endpoints: agents list/spawn/get/events/stop/resume/rename/permission/remove; projects list/create/delete; `/internal/permission-request` (held open); `/internal/agent-hook`; `/healthz`. Used by the MCP shim and agent hooks, not by the GUI (which uses IPC). | working | `curl /healthz`; smoke test |
| DAE-04 | Process management | Line-based pipe spawning with SIGTERM→SIGKILL escalation; PTY processes owned and cleaned up by the daemon; on app quit all agents are stopped. | working | Quit the app with agents running |
| DAE-05 | App window behavior | Closing the window does not quit: the daemon (and agents) keep running; the dock icon re-opens the window; quitting stops agents. macOS dock icon + app name set to Maiestro. | working | Close window, agent keeps running |

## 9. Testing / tooling (TST)

| ID  | Feature | Details | Status | Verification |
| --- | --- | --- | --- | --- |
| TST-01 | Smoke test | `npm run smoke`: end-to-end with real claude + vibe agents in a temp data dir (spawn → blocked → approve → done → effects checked). Costs a little API money. | working | `npm run smoke` |
| TST-02 | Typecheck / build | `npm run typecheck` (node + web tsconfigs), `npm run build` (main + preload + renderer). | working | Run both |
| TST-03 | Dev flow | `npm run dev` (Electron dev server), `npm run daemon` (standalone daemon). | working | — |

## Known gaps / not implemented (planned)

- Packaging with electron-builder (the app currently runs from dev tooling only).
- Tray icon; "always allow" permission rules.
- External/observed agents (hooks POSTing to `/api/agents/:id/events`).
- Terminal-session records exist in types (`TerminalSession`) but are not exposed as standalone terminals attached to a project; only terminal-*mode* agents exist today (the pinned `shell` pane of TRM-08 is a terminal-mode agent with tool `shell`).

## Changelog

- 2025 (initial): inventory written from the codebase (daemon, adapters, UI)
  and HANDOFF.md; all implemented features listed above.
