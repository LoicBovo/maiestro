#!/bin/bash
# Probe A: does claude print-mode with --input-format stream-json emit control_request
# for permission prompts, and accept control_response to unblock?
set -u
DIR=/Users/loicbovo/Documents/code/perso/agent-console/spike/samples
FIFO=/tmp/claude-stdin
TARGET=/tmp/claude-spike-ctrl.txt
rm -f "$FIFO" "$TARGET" "$DIR/claude-ctrl.jsonl" "$DIR/claude-ctrl.err" /tmp/claude-ctrl.exit
mkfifo "$FIFO"

cd /tmp
(claude -p "Run this exact bash command: touch /tmp/claude-spike-ctrl.txt" \
  --input-format stream-json --output-format stream-json --verbose --permission-prompts host \
  < "$FIFO" > "$DIR/claude-ctrl.jsonl" 2> "$DIR/claude-ctrl.err"; echo "exit=$?" > /tmp/claude-ctrl.exit) &
BG=$!
exec 3>"$FIFO"   # hold the write end open

sleep 30
echo "=== events at 30s ==="
python3 - "$DIR/claude-ctrl.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    try: d = json.loads(line)
    except Exception: print('RAW:', line[:200]); continue
    t = d.get('type')
    if t == 'control_request':
        print('CONTROL_REQUEST:', json.dumps(d)[:600])
    elif t == 'assistant':
        for c in d.get('message', {}).get('content', []):
            if c.get('type') == 'tool_use':
                print('TOOL_USE:', c.get('name'), json.dumps(c.get('input'))[:200])
    elif t == 'user':
        for c in d.get('message', {}).get('content', []):
            if isinstance(c, dict) and c.get('type') == 'tool_result':
                print('TOOL_RESULT is_error:', c.get('is_error'), '|', str(c.get('content'))[:200])
    elif t == 'result':
        print('RESULT subtype:', d.get('subtype'), '|', str(d.get('result'))[:150])
    elif t == 'system' and d.get('subtype') == 'init':
        print('INIT ok')
    else:
        print('other:', t, d.get('subtype', ''))
PY
echo "--- target file? ---"; ls -la "$TARGET" 2>&1
echo "--- process alive? ---"; kill -0 $BG 2>/dev/null && echo "claude still running" || echo "claude exited"

REQ_ID=$(grep -o '"request_id":"[^"]*"' "$DIR/claude-ctrl.jsonl" | head -1 | cut -d'"' -f4)
echo "REQ_ID=$REQ_ID"
if [ -n "$REQ_ID" ]; then
  printf '{"type":"control_response","request_id":"%s","response":{"behavior":"allow","updatedInput":{"command":"touch /tmp/claude-spike-ctrl.txt"}}}\n' "$REQ_ID" >&3
  echo "sent allow response"
  sleep 25
  echo "=== events after allow ==="
  python3 - "$DIR/claude-ctrl.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    try: d = json.loads(line)
    except Exception: continue
    t = d.get('type')
    if t == 'user':
        for c in d.get('message', {}).get('content', []):
            if isinstance(c, dict) and c.get('type') == 'tool_result':
                print('TOOL_RESULT is_error:', c.get('is_error'), '|', str(c.get('content'))[:200])
    elif t == 'result':
        print('RESULT subtype:', d.get('subtype'), '|', str(d.get('result'))[:150])
    elif t == 'assistant':
        for c in d.get('message', {}).get('content', []):
            if c.get('type') == 'text':
                print('TEXT:', c.get('text', '')[:150])
PY
  echo "--- target file? ---"; ls -la "$TARGET" 2>&1
fi

exec 3>&-
sleep 5
kill $BG 2>/dev/null
wait $BG 2>/dev/null
echo "--- exit ---"; cat /tmp/claude-ctrl.exit 2>/dev/null
echo "--- stderr ---"; head -c 400 "$DIR/claude-ctrl.err"
