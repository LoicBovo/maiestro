/**
 * Source of the MCP permission shim. The daemon writes this to
 * <dataDir>/bin/mcp-permission-shim.cjs at startup and points Claude Code at
 * it via --mcp-config. Written as a string (not imported) so it works the
 * same in dev and in a packaged app (no asar path issues).
 *
 * Protocol: MCP over stdio (JSON-RPC, newline-delimited). Claude calls the
 * `permission_decision` tool with {tool_name, input, tool_use_id}; the shim
 * forwards the request to the daemon over HTTP and blocks until the daemon
 * answers with the user's decision: {behavior:'allow',updatedInput} or
 * {behavior:'deny',message}.
 */
export const SHIM_SOURCE = String.raw`
'use strict';
// maiestro MCP permission shim (generated file — do not edit the copy in
// the data dir; edit electron/daemon/shim-source.ts instead)
var URL = process.env.MAIESTRO_URL;
var TOKEN = process.env.MAIESTRO_TOKEN;
var AGENT_ID = process.env.MAIESTRO_AGENT_ID;

function send(o) {
  process.stdout.write(JSON.stringify(o) + '\n');
}

function deny(m) {
  return { behavior: 'deny', message: m };
}

function askDaemon(args) {
  return fetch(URL + '/internal/permission-request', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + TOKEN,
    },
    body: JSON.stringify({
      agentId: AGENT_ID,
      toolUseId: args.tool_use_id,
      toolName: args.tool_name,
      input: args.input || {},
    }),
  })
    .then(function (res) {
      if (!res.ok) return deny('daemon returned HTTP ' + res.status);
      return res.json();
    })
    .catch(function (e) {
      return deny('could not reach daemon: ' + (e && e.message));
    });
}

function handle(line) {
  var msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // notification
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'maiestro', version: '0.1.0' },
      },
    });
  } else if (msg.method === 'server/discover') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'permission_decision',
            description: 'Decide an agent permission request',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
  } else if (msg.method === 'tools/call') {
    var args = (msg.params && msg.params.arguments) || {};
    askDaemon(args).then(function (decision) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify(decision) }] },
      });
    });
  }
}

var buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (c) {
  buf += c;
  var i;
  while ((i = buf.indexOf('\n')) >= 0) {
    var line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
process.stdin.on('end', function () {
  process.exit(0);
});
`
