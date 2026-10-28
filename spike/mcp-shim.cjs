// Minimal MCP stdio server: logs every JSON-RPC message, answers tools/call
// with an "allow" permission decision so we can observe the exact schema
// Claude Code uses for --permission-prompt-tool.
const fs = require('fs');
const readline = require('readline');

const LOG = process.env.SPIKE_LOG || '/tmp/mcp-shim.log';

function send(o) {
  process.stdout.write(JSON.stringify(o) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  fs.appendFileSync(LOG, line + '\n');
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-console-spike', version: '0.1.0' },
    } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{
      name: 'permission_decision',
      description: 'Decide a Claude Code permission request',
      inputSchema: { type: 'object', properties: {} },
    } ] } });
  } else if (msg.method === 'tools/call') {
    const args = (msg.params && msg.params.arguments) || {};
    fs.appendFileSync(LOG + '.call', JSON.stringify(msg.params, null, 1) + '\n');
    const decision = { behavior: 'allow', updatedInput: args.input || {} };
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: JSON.stringify(decision) }],
    } });
  } else if (msg.method === 'server/discover') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
