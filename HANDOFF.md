# Maiestro — handover document

Read this first. It describes what exists, what is verified, what is broken,
and exactly what to do next.

## What this project is

A desktop GUI (Electron + Svelte) to manage multiple coding agents:

- Dashboard of all agents with live status (`running | blocked | done | error | stopped`)
- Grouping of agents per user-defined **project**; agents with no project are open **solo**
- OS notifications when an agent is **blocked**, **done**, or **error**
- Unblock flow: answer a blocked agent from the GUI
- v1 supports two agent tools: **Claude Code** (`claude`) and **Mistral Vibe** (`vibe`)

Project root: `/Users/loicbovo/Documents/code/perso/maiestro`

## Status at handover

**Verified working (real agents, end-to-end):** the Claude Code path. The smoke
test (`npm run smoke`) passed all Claude checks: spawn → blocked (permission
request) → approve via HTTP → done → file actually created by the agent →
events recorded. Log of that run: `/tmp/maiestro-smoke.log` (may be gone).

**Known bug (one-liner fix, see below):** the Vibe adapter. Smoke test timed out
waiting for a vibe agent to become `blocked`; the agent sat in `running` with
zero events.

**Written but not yet run/verified:** `electron/main.ts`, `electron/preload.ts`.

**Not yet written:** the Svelte UI components (see Remaining work).

**Not yet run:** `npm run typecheck`, `npm run build`.

## The known bug and its fix

Symptom: a spawned vibe agent never emits events; status stays `running`.

Root cause (verified experimentally): **vibe headless blocks reading stdin when
stdin is an open pipe**, producing no output until EOF. Verified: with
`stdin: 'ignore'`, vibe streams its JSONL output live (first data at +1.5s,
exit at +2.4s for a trivial task). `electron/daemon/process.ts`
(`spawnLineProcess`) currently hardcodes `stdio: ['pipe', 'pipe', 'pipe']` and
never closes stdin.

Fix: add a stdin option to `spawnLineProcess` (e.g. `opts.stdin?: 'pipe' |
'ignore'`, default `'pipe'`) and spawn vibe with `stdin: 'ignore'` in
`electron/daemon/adapters/vibe.ts`. (Claude in `-p` mode with a text prompt does
not read stdin — it worked fine in the smoke test with a pipe stdin — but you
may use `'ignore'` for it too after re-verifying.)

Then re-run `npm run smoke` and confirm all checks pass, including the vibe
blocked → stop and vibe done checks.

## Architecture

```
electron/main.ts            Electron shell: window, tray-less, IPC, Notification API
  └─ electron/daemon/daemon.ts   Daemon (UI-agnostic orchestrator)
       ├─ registry.ts          in-memory agents + status transitions + permission state
       ├─ store.ts             JSON persistence (~/.maiestro: agents.json, events.jsonl, projects.json, config.json)
       ├─ server.ts            HTTP API on 127.0.0.1, bearer-token auth
       ├─ process.ts           spawnLineProcess: pipes, line streams, SIGTERM→SIGKILL
       ├─ notifier.ts          status transitions → notifications (delivery injected)
       ├─ shim-source.ts       MCP permission shim source (written to <dataDir>/bin/ at startup)
       ├─ adapters/claude.ts   stream-json parsing + MCP permission wiring
       ├─ adapters/vibe.ts     streaming JSONL parsing, blocked = tool_denied
       ├─ cli.ts               standalone daemon (no Electron): npm run daemon
       └─ smoke.ts             end-to-end test with real agents: npm run smoke
electron/preload.ts         contextBridge API → window.maiestro
src/                        Svelte renderer (Vite root)
  ├─ lib/api.ts, lib/state.ts, lib/types.ts   (written)
  └─ App.svelte + lib/components/* + app.css  (NOT written yet)
spike/                      research: FINDINGS.md + raw samples + probe scripts
```

Data flow: adapter parses agent stdout → `daemon.emit()` → registry persists +
pushes `agents:changed` / `agent:event` over IPC to the renderer. Permission
requests (Claude) flow the other way: claude → MCP shim (spawned by claude via
`--mcp-config`) → shim POSTs `/internal/permission-request` and **blocks** →
daemon marks agent `blocked` + notifies → user clicks Approve/Deny in GUI →
IPC → daemon resolves the held HTTP request → shim returns the decision to
claude → agent continues.

## Verified protocol facts (from the spike — details in spike/FINDINGS.md)

- **Claude** (`claude -p <task> --output-format stream-json --verbose`):
  stdout is JSONL (`system`/`assistant`/`user`/`result`). Done = `result` with
  `subtype: 'success'`. Permissions: `--permission-prompt-tool` must be an
  **MCP tool name** (`mcp__maiestro__permission_decision`) backed by a stdio
  MCP server (our shim, passed via `--mcp-config`). The shim receives
  `tools/call` with `{tool_name, input, tool_use_id}` and must reply with a tool
  result whose text is `{"behavior":"allow","updatedInput":{...}}` or
  `{"behavior":"deny","message":"..."}` (NOT wrapped in `decision` — that is
  rejected). The raw stdio `control_request` protocol does NOT emit permission
  requests in claude 2.1.311. Verified: allow → command ran → file created.
- **Vibe** (`vibe -p <task> --output streaming --workdir <cwd> --agent <policy> --max-turns N`):
  stdout is JSONL but tolerate non-JSON lines (a trailing `Error:` was observed).
  Events: `message` (role/content), `reasoning`, `effect` (tool executions;
  `state.status: 'failed'` + `state.error.code: 'tool_denied'` = denied),
  `callback` (approval answered; headless auto-`deny`s). Headless vibe **never
  waits for input** — unblock = relaunch with a different `--agent` policy
  (`ask | plan | accept-edits | smart-approve | auto-approve`). Done = exit 0.
  **Vibe blocks on an open stdin pipe — spawn it with stdin ignored.**

## How to run

```
npm run daemon     # standalone daemon (console notifications; MAIESTRO_OS_NOTIFY=1 for macOS popups)
npm run smoke      # end-to-end test with real claude+vibe agents (~3-4 min, costs a few $0.1 of API)
npm run dev        # Electron app (dev server)
npm run build      # electron-vite build (main+preload+renderer)
npm run typecheck  # tsc --noEmit for node + web configs
```

Data dir: `~/.maiestro` (override with `MAIESTRO_HOME`). Smoke uses a
temp dir. HTTP API: `http://127.0.0.1:49377` (first free port from there),
`Authorization: Bearer <token>` (token in `<dataDir>/config.json`).

## Environment gotchas (this machine)

- **npm**: the global registry is a private mirror that 403s on some packages.
  Install with `npm install --registry=https://registry.npmjs.org ...`.
  Do NOT edit `~/.npmrc`.
- **No `timeout` or `setsid` binaries.** Use the bash tool's `timeout_seconds`;
  for background jobs use `nohup ... & disown` and poll the log file.
- **tsx treats .ts as CJS** (package.json has no `"type": "module"`) — no
  top-level await; wrap entrypoints in `async function main()` + `void main()`.
- bash tool parameter is `timeout_seconds` (not `timeout`).
- Dependencies already installed: electron 45, electron-vite 6, svelte 5.57,
  vite 8, typescript 7, tsx, @types/node. Svelte 5 is used in legacy syntax
  (`export let`, `on:click`) deliberately.

## Design decisions (and deviations from the original plan)

- **JSON persistence, not SQLite** — avoids native-module rebuilds in
  Electron; agents.json is small, events.jsonl is append-only.
- **No node-pty** — both CLIs work over pipes in headless mode. (Interactive
  TUI mode would be a later phase and would need node-pty.)
- **Vibe "blocked" = denied approval** (`tool_denied` effect), because headless
  vibe auto-denies instead of waiting. The GUI's answer is stop/relaunch with a
  different approval policy, not a mid-run answer.
- **MCP shim is generated at startup** into the data dir (from
  `shim-source.ts`), so it works identically in dev and packaged builds.
- Agents are spawned and owned by the daemon; on daemon restart, previously
  running agents are marked `stopped` ("daemon restarted").

## Remaining work (in order)

1. **Fix the vibe stdin bug** (see above), re-run `npm run smoke` until all
   checks pass.
2. **Write the renderer UI** (Svelte 5 legacy syntax):
   - `src/app.css` — dark theme, 3-pane layout (sidebar | agent list | detail)
   - `src/App.svelte` — layout + `onMount(() => init())` from `src/lib/state.ts`
   - `src/lib/components/FilterBar.svelte` — tool + status filters
   - `src/lib/components/StatusBadge.svelte` — colored status dot
   - `src/lib/components/AgentCard.svelte` — one row per agent (tool, project/solo, task, status, lastMessage)
   - `src/lib/components/AgentDetail.svelte` — task/status/times/cost, live event
     log (auto-scroll), actions: Stop, Relaunch (for vibe: pick approval policy
     first), and when `agent.pendingPermission` is set: Approve/Deny buttons
     calling `api.decidePermission(...)`
   - `src/lib/components/SpawnDialog.svelte` — modal: tool select, project select
     (solo or one of `$projects`), task textarea, cwd (defaults to the project's
     main folder; native folder picker via `api.pickDirectory()`), vibe policy
     + maxTurns (vibe only); submit → `api.spawnAgent`
   - State helpers already exist in `src/lib/state.ts` (stores: agents,
     visibleAgents, selectedAgent, selectedEvents, projects, filters; `init()`,
     `selectAgent(id)`, `createProject()`, `deleteProject()`).
3. **`npm run typecheck`** — fix any errors (note: typescript@7 is the native
   compiler; if its `tsc` CLI misbehaves, that's why).
4. **`npm run build`** — must produce out/main, out/preload, out/renderer.
5. **Eyeball the app**: `npm run dev` (opens a window on the user's Mac).
   Spawn a real agent, watch it block on a permission, approve it.
6. **Later (not v1):** packaging with electron-builder; external/observed agents
   (hooks POSTing to `/api/agents/:id/events`); tray icon; "always allow"
   permission rules; interactive TUI agents via node-pty.

## Todo-list state at handover

Done: spike (claude + vibe protocols), scaffold, daemon (server/registry/
persistence/process manager/notifier), claude adapter, vibe adapter (has the
stdin bug), smoke test written + Claude path verified.
In progress / pending: vibe stdin fix + smoke re-run; renderer UI; typecheck;
electron build; manual GUI check.
