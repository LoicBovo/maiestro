# Architecture

Component map of Maiestro and the vocabulary used to talk about it. The names
below refer to what the code actually does, not just the file names.

```
Maiestro (Electron app: GUI to manage multiple coding agents)
├── Electron Shell (electron/)
│   ├── Main Process — electron/main.ts
│   │     Owns the BrowserWindow, runs the Daemon in-process, exposes
│   │     agents/terminal/project IPC channels, fires OS notifications,
│   │     focuses the window + agent on notification click, runs `gh pr list`.
│   ├── Preload Bridge — electron/preload.ts
│   │     contextBridge API the renderer sees (window.maiestro): listAgents,
│   │     spawnAgent, decidePermission, terminal attach/write/resize, projects.
│   └── Daemon (electron/daemon/) — the agent-management core, Electron-free
│       ├── Daemon — daemon.ts        Orchestrator: starts server, writes shim
│       │                             file, spawns agents via adapters, emits
│       │                             agents/events/terminal-data callbacks.
│       ├── Server — server.ts        Local HTTP API on 127.0.0.1 (~49377),
│       │                             bearer-token auth; used by renderer IPC
│       │                             bridge, external-agent hooks, MCP shim.
│       ├── Registry — registry.ts     In-memory source of truth for agents,
│       │                             projects, pending permission requests;
│       │                             emits agents/event/status transitions.
│       ├── Store — store.ts          JSON persistence (~/.maiestro):
│       │                             agents.json, events.jsonl, projects.json.
│       ├── Notifier — notifier.ts    Maps status transitions → notification
│       │                             calls (delivery injected by host).
│       ├── Adapters — adapters/      Per-tool launch + stream parsing
│       │     ├── Claude — claude.ts  `claude` JSON streaming + permission
│       │     │                       gating via MCP shim
│       │     ├── Vibe — vibe.ts       `vibe` JSON streaming (records sessionId
│       │     │                       for resume)
│       │     └── PTY — pty.ts          Embedded-terminal agents via node-pty
│       │                              (this is the "shell" pane)
│       ├── Process — process.ts      Line-buffered child-process helper
│       │                             (SIGTERM → SIGKILL escalation).
│       ├── MCP Permission Shim — shim-source.ts
│       │     Source of mcp-permission-shim.cjs written to the data dir; lets
│       │     Claude Code call home for allow/deny decisions over the Server.
│       ├── PRs — prs.ts              `gh pr list` per project directory.
│       ├── Types — types.ts          Shared Agent, Project, AgentEvent,
│       │                             SpawnOptions, PullRequest models.
│       ├── CLI — cli.ts              Standalone daemon entry (`npm run daemon`).
│       └── Smoke — smoke.ts          Daemon smoke test (`npm run smoke`).
└── Renderer (src/) — Svelte 5 UI
    ├── App — App.svelte              Layout: agent list vs. detail + PRs pane.
    ├── API client — lib/api.ts        Typed wrapper over the preload bridge.
    ├── State — lib/state.ts           Svelte stores: agents, projects,
    │                                  filters (project/tool/status), selection,
    │                                  PR-pane open flag.
    ├── Types — lib/types.ts           Renderer-side model types.
    └── Components — lib/components/
        ├── AgentCard          Agent tile in the list (status, name, tool).
        ├── AgentDetail        Right pane: events, resume/prompt, permission
        │                      prompts, rename, remove.
        ├── TerminalPane       xterm.js view of PTY agents (attach/write/resize).
        ├── SpawnDialog        Create an agent (tool, project, task, options).
        ├── FilterBar          Project / tool / status filters.
        ├── StatusBadge        Status chip widget.
        └── PullRequestsPane   Open PRs per project.
```

Adjacent, non-runtime pieces:

- `spike/` — throwaway probes that informed the daemon design (see
  `spike/FINDINGS.md`).
- `out/` — electron-vite build output (main, preload, renderer).
- `release/` — electron-builder artifacts (.app, .dmg).
- `README.md` / `FEATURES.md` / `HANDOFF.md` — docs.

Data flow, in one line:

```
Renderer --preload bridge--> Main Process --in-process calls--> Daemon
  (Registry -> adapters -> CLI processes)  ... adapters/hook shim --HTTP-->
Server (the daemon's local, token-authenticated API)
```

## Vocabulary

- **Agent** — one managed process instance (Claude, Vibe, or shell/PTY).
- **Project** — a named group of repo directories an agent can belong to.
- **Daemon** — the Electron-free agent-management core. The Electron main
  process is one host for it; `npm run daemon` (CLI) is the other.
- **Server** — the daemon's local HTTP API on 127.0.0.1, bearer-token
  authenticated. The renderer reaches the daemon through IPC via the main
  process, not over HTTP.
- **Registry** — the in-memory source of truth; **Store** — its on-disk JSON
  persistence.
- **Adapter** — per-tool spawn + stream-parsing logic (Claude, Vibe, PTY).
- **Permission shim** — the MCP shim Claude Code is pointed at so its
  permission asks are routed into the GUI for allow/deny decisions.
- **Shell** — a PTY agent rendered in an embedded terminal, not counted as a
  coding agent in the UI.

## UI regions

The main window is four columns (the last one toggleable). The names match
the CSS classes in `src/App.svelte` and the components, so code and
conversation stay aligned.

```
├── Sidebar — aside.sidebar (src/App.svelte)
│     Left column: Maiestro logo/title, "+ New agent" button, and the
│     Projects list (All agents / Solo / user projects, with live agent
│     counts). All agent/project filtering is driven from here.
├── List pane — main.list-pane (src/App.svelte)
│     The agent column: FilterBar (tool/status filters) on top and the
│     AgentCard grid below. This is where agent tiles live.
├── Detail pane — section.detail-pane (src/App.svelte → AgentDetail)
│     Right pane for the selected agent: events, rename, resume prompt,
│     permission Approve/Deny bar, and the TerminalPane (embedded xterm
│     terminal) for shell agents. The terminal pane is a child of the
│     detail pane, not a separate column.
└── PRs pane — PullRequestsPane (aside.prs-pane)
      Toggleable rightmost column: open pull requests per project.
      Collapses to a thin rail (prs-rail) when closed.
```
