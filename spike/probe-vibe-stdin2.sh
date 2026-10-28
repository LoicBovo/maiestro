#!/bin/bash
# Probe B2: vibe --agent ask with open stdin. Send several approval-answer formats,
# then EOF, then WAIT for natural exit before reading buffered output.
set -u
DIR=/Users/loicbovo/Documents/code/perso/agent-console/spike/samples
FIFO=/tmp/vibe-stdin2
TARGET=/tmp/vibe-spike-pipe.txt
rm -f "$FIFO" "$TARGET" "$DIR/vibe-pipe2.jsonl" "$DIR/vibe-pipe2.err" /tmp/vibe-pipe2.exit
mkfifo "$FIFO"

cd /tmp
(vibe -p "Use your file tools to create /tmp/vibe-spike-pipe.txt containing exactly: pipe-test" \
  --output streaming --agent ask --workdir /tmp \
  < "$FIFO" > "$DIR/vibe-pipe2.jsonl" 2> "$DIR/vibe-pipe2.err"; echo "exit=$?" > /tmp/vibe-pipe2.exit) &
BG=$!
exec 4>"$FIFO"

sleep 12
echo "--- alive at 12s? ---"; kill -0 $BG 2>/dev/null && echo running || echo exited

echo "=== sending JSON allow answers ==="
for i in 1 2 3 4; do printf '{"type":"approval","decision":{"type":"allow"}}\n' >&4; sleep 4; done
echo "--- alive after json answers? ---"; kill -0 $BG 2>/dev/null && echo running || echo exited

echo "=== sending plain y answers ==="
for i in 1 2 3 4; do printf 'y\n' >&4; sleep 4; done
echo "--- alive after y answers? ---"; kill -0 $BG 2>/dev/null && echo running || echo exited

echo "=== closing stdin (EOF) ==="
exec 4>&-

for i in $(seq 1 24); do [ -f /tmp/vibe-pipe2.exit ] && break; sleep 5; done
kill $BG 2>/dev/null; wait $BG 2>/dev/null
echo "--- exit ---"; cat /tmp/vibe-pipe2.exit 2>/dev/null || echo "still running (killed)"
echo "--- target file? ---"; ls -la "$TARGET" 2>&1
echo "=== full event log ==="
python3 - "$DIR/vibe-pipe2.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    try: d = json.loads(line)
    except Exception: print('RAW:', line[:200]); continue
    t = d.get('type')
    st = d.get('state') if isinstance(d.get('state'), dict) else {}
    print('===', t, '| status:', st.get('status', ''))
    if t == 'callback':
        print('   ', json.dumps(d)[:400])
    elif t == 'effect':
        print('    title:', d.get('title'), '| decision:', st.get('decision'), '| err:', (st.get('error') or {}).get('code'))
    elif t == 'message':
        print('    role:', d.get('role'), '|', json.dumps(d.get('content'))[:200])
PY
echo "--- stderr ---"; head -c 800 "$DIR/vibe-pipe2.err"
