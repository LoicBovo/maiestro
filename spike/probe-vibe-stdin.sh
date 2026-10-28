#!/bin/bash
# Probe B: with an OPEN stdin pipe, does vibe --agent ask wait for an approval answer?
set -u
DIR=/Users/loicbovo/Documents/code/perso/agent-console/spike/samples
FIFO=/tmp/vibe-stdin
TARGET=/tmp/vibe-spike-pipe.txt
rm -f "$FIFO" "$TARGET" "$DIR/vibe-pipe.jsonl" "$DIR/vibe-pipe.err" /tmp/vibe-pipe.exit
mkfifo "$FIFO"

cd /tmp
(vibe -p "Use your file tools to create /tmp/vibe-spike-pipe.txt containing exactly: pipe-test" \
  --output streaming --agent ask --workdir /tmp \
  < "$FIFO" > "$DIR/vibe-pipe.jsonl" 2> "$DIR/vibe-pipe.err"; echo "exit=$?" > /tmp/vibe-pipe.exit) &
BG=$!
exec 4>"$FIFO"

summarize() {
python3 - "$DIR/vibe-pipe.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    try: d = json.loads(line)
    except Exception: print('RAW:', line[:200]); continue
    t = d.get('type')
    st = d.get('state') or {}
    print('===', t, '| state.status:', st.get('status') if isinstance(st, dict) else '')
    if t == 'callback':
        print('   callback:', json.dumps(d)[:500])
    elif t == 'effect':
        print('   title:', d.get('title'))
        if isinstance(st, dict):
            print('   decision:', st.get('decision'), '| approvalSource:', st.get('approvalSource'), '| error:', (st.get('error') or {}).get('code'))
    elif t == 'message':
        print('   role:', d.get('role'), '|', json.dumps(d.get('content'))[:200])
PY
}

sleep 20
echo "=== events at 20s ==="
summarize
echo "--- target file? ---"; ls -la "$TARGET" 2>&1
echo "--- vibe alive? ---"; kill -0 $BG 2>/dev/null && echo "vibe still running" || echo "vibe exited"
echo "--- stderr so far ---"; head -c 600 "$DIR/vibe-pipe.err"

echo "=== sending 'y' on stdin ==="
printf 'y\n' >&4
sleep 15
echo "=== events after y ==="
summarize
echo "--- target file? ---"; ls -la "$TARGET" 2>&1

echo "=== sending JSON approval on stdin ==="
printf '{"type":"approval","decision":{"type":"allow"}}\n' >&4
sleep 15
echo "=== events after json ==="
summarize
echo "--- target file? ---"; ls -la "$TARGET" 2>&1

exec 4>&-
sleep 3
kill $BG 2>/dev/null
wait $BG 2>/dev/null
echo "--- exit ---"; cat /tmp/vibe-pipe.exit 2>/dev/null
echo "--- final stderr ---"; head -c 600 "$DIR/vibe-pipe.err"
