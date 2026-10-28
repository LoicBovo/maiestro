# Spike findings — agent event ingestion (2026-10-27)

Environment: `claude` 2.1.311 (`/Users/loicbovo/.local/bin/claude`), `vibe` (Rust TUI, new preview CLI),
Node 25.8.2, macOS. Raw samples in `spike/samples/`.

## Claude Code

Spawn (headless, structured, with permission channel):

```
claude -p "<task>" \
  --output-format stream-json --verbose \
  --permission-prompt-tool mcp__maiestro__permission_decision \
  --mcp-config '{"mcpServers":{"maiestro":{"command":"node","args":["<shim.cjs>"],"env":{...}}}}'
```

stdout is JSONL. Relevant message types:

| type | meaning | key fields |
|---|---|---|
| `system` / `init` | session started | `session_id`, `cwd`, `model`, `permissionMode` |
| `system` / `permission_denied` | a permission was auto-denied (no host) | `tool_name`, `request_id` |
| `system` / `hook_started`, `hook_response`, `commands_changed`, `thinking_tokens`, `rate_limit_event` | noise (verbose mode) | filter out |
| `assistant` | model turn | `message.content[]` blocks: `text`, `tool_use {name, id, input}` |
| `user` | tool result | `message.content[]`: `tool_result {tool_use_id, is_error, content}` |
| `result` | run finished | `subtype` (`success`, `error_*`), `is_error`, `result` (final text), `total_cost_usd`, `session_id` |

**Blocked / unblock (verified end-to-end):** when a tool needs permission, Claude calls the
MCP tool given via `--permission-prompt-tool` (must be an MCP tool name like
`mcp__<server>__<tool>`, NOT a shell command) with `tools/call` arguments:

```json
{ "tool_name": "Bash", "input": { "command": "..." }, "tool_use_id": "toolu_..." }
```

The MCP server must reply with a tool result whose text content is JSON:

- allow: `{"behavior":"allow","updatedInput":{...}}`
- deny:  `{"behavior":"deny","message":"..."}`

(Wrapping in `{"decision": ...}` is rejected: "invalid permission result".)
MCP handshake observed: `server/discover` (respond with `{}`), `initialize`,
`notifications/initialized`, `tools/list`, `tools/call`.
Verified: shim answered `allow` -> `touch /tmp/claude-spike-mcp.txt` ran, file created.

Notes:
- `--input-format stream-json` makes the CLI read the user turn from stdin; the raw
  `control_request`/`control_response` protocol did NOT emit permission requests in this
  build — permissions were auto-denied. The MCP permission-prompt-tool is the working channel.
- Without `--permission-prompt-tool`, a needed permission arrives as `tool_result` with
  `is_error: true` ("needs approval ... couldn't be shown in this session") and the run
  continues. So blocked-detection for Claude = the MCP `tools/call` arriving at our shim.

## Mistral Vibe

Spawn (headless):

```
vibe -p "<task>" --output streaming --workdir <cwd> [--agent ask|plan|accept-edits|smart-approve|auto-approve] [--max-turns N]
```

stdout is JSONL but NOT guaranteed pure JSON (a trailing `Error:` line appeared once —
tolerate unparseable lines). Event types:

| type | meaning | key fields |
|---|---|---|
| `message` | user/assistant turn | `role`, `content[]` (`{type:'text',text}`), `createdAt` (epoch ms) |
| `reasoning` | model thinking | `text` |
| `effect` | a tool execution | `title` = tool name (e.g. `file_system.bash`), `detail.toolName`, `detail.input`, `state.status` (`completed`/`failed`), `state.decision` (`execute`/`skip`), `state.approvalSource` (`config`/`user`), `state.error.code` (`tool_denied`, `tool_failed`) |
| `callback` | an approval was answered | `state.output.type === 'approval'`, `state.output.decision.type` (`allow`/`deny`) |

**Blocked (verified):** headless vibe NEVER waits for input. With `--agent ask`, every
approval is auto-denied immediately (`callback` answered with `deny`; effect fails with
`tool_denied`). With the default agent, approvals auto-execute (`approvalSource: 'config'`).
Reading answers from an open stdin pipe does NOT work (probe: process kept running, all
denials, crashed with exit=1 and a trailing `Error:` line).

=> For vibe, "blocked" = denied-approval (`callback` deny or `effect` failed/`tool_denied`).
Unblock flow = relaunch with a different approval policy (`--agent smart-approve` /
`--auto-approve` / `accept-edits`), or stop. Per-need approval policy is a spawn option.

**Done:** process exit code 0. **Error:** non-zero exit (vibe exited 1 after flailing on
denials, with a non-JSON `Error:` line on stdout).

## Common event schema (adapters normalize to this)

```ts
type AgentStatus = 'running' | 'blocked' | 'done' | 'error' | 'stopped';
// events: tool_use | tool_result | message | blocked | done | error | log
```
