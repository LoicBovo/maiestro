#!/bin/bash
# Probe A2: claude stream-json BOTH ways. Send initial user message on stdin,
# watch for control_request, answer it with control_response.
set -u
DIR=/Users/loicbovo/Documents/code/perso/agent-console/spike/samples
FIFO=/tmp/claude-stdin2
TARGET=/tmp/claude-spike-ctrl.txt
rm -f "$FIFO" "$TARGET" "$DIR/claude-ctrl2.jsonl" "$DIR/claude-ctrl2.err" /tmp/claude-ctrl2.exit
mkfifo "$FIFO"

cd /tmp
(claude --input-format stream-json --output-format stream-json --verbose --permission-prompts host \
  < "$FIFO" > "$DIR/claude-ctrl2.jsonl" 2> "$DIR/claude-ctrl2.err"; echo "exit=$?" > /tmp/claude-ctrl2.exit) &
BG=$!
exec 3>"$FIFO"

summarize() {
python3 - "$DIR/claude-ctrl2.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    try: d = json.loads(line)
    except Exception: print('RAW:', line[:200]); continue
    t = d.get('type')
    if t == 'control_request':
        print('CONTROL_REQUEST:', json.dumps(d)[:700])
    elif t == 'assistant':
        for c in d.get('message', {}).get('content', []):
            if c.get('type') == 'tool_use':
                print('TOOL_USE:', c.get('name'), json.dumps(c.get('input'))[:200])
            elif c.get('type') == 'text':
                print('TEXT:', c.get('text', '')[:150])
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
}

# send the initial user message (stream-json input format)
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Run this exact bash command: touch /tmp/claude-spike-ctrl.txt"}}' >&3
echo "sent user message"

sleep 35
echo "=== events at 35s ==="
summarize
echo "--- target file? ---"; ls -la "$TARGET" 2>&1
echo "--- claude alive? ---"; kill -0 $BG 2>/dev/null && echo running || echo exited

REQ_ID=$(grep -o '"request_id":"[^"]*"' "$DIR/claude-ctrl2.jsonl" | head -1 | cut -d'"' -f4)
echo "REQ_ID=$REQ_ID"
if [ -n "$REQ_ID" ]; then
  printf '{"type":"control_response","request_id":"%s","response":{"behavior":"allow","updatedInput":{"command":"touch /tmp/claude-spike-ctrl.txt"}}}\n' "$REQ_ID" >&3
  echo "sent allow response"
  sleep 30
  echo "=== events after allow ==="
  summarize
  echo "--- target file? ---"; ls -la "$TARGET" 2>&1
fi

exec 3>&-
for i in $(seq 1 12); do [ -f /tmp/claude-ctrl2.exit ] && break; sleep 5; done
kill $BG 2>/dev/null; wait $BG 2>/dev/null
echo "--- exit ---"; cat /tmp/claude-ctrl2.exit 2>/dev/null
echo "--- stderr ---"; head -c 500 "$DIR/claude-ctrl2.err"
