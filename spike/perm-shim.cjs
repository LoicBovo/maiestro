const fs = require('fs');
let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.SPIKE_LOG || '/tmp/perm-request.json', data);
  let req = {};
  try { req = JSON.parse(data); } catch {}
  const decision = { decision: { behavior: 'allow', updatedInput: req.input || {} } };
  process.stdout.write(JSON.stringify(decision));
});
