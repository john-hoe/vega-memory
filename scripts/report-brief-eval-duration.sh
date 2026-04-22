#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <task-dir>" >&2
  exit 1
fi

TASK_DIR="$1"
META_PATH="$TASK_DIR/meta.json"
RESULT_PATH="$TASK_DIR/result.md"

if [[ ! -f "$META_PATH" ]]; then
  echo "Meta not found: $META_PATH" >&2
  exit 1
fi

if [[ ! -f "$RESULT_PATH" ]]; then
  echo "Result not found: $RESULT_PATH" >&2
  exit 1
fi

python3 - "$META_PATH" "$RESULT_PATH" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

meta_path, result_path = sys.argv[1:3]
with open(meta_path, "r", encoding="utf-8") as f:
    meta = json.load(f)

start_epoch = int(meta["prepared_at_epoch"])
end_epoch = int(os.path.getmtime(result_path))
duration = max(0, end_epoch - start_epoch)

def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

hours, remainder = divmod(duration, 3600)
minutes, seconds = divmod(remainder, 60)

print(f"TASK_ID={meta['task_id']}")
print(f"RUNNER={meta.get('runner', 'unknown')}")
print(f"START_EPOCH={start_epoch}")
print(f"END_EPOCH={end_epoch}")
print(f"START_ISO={meta['prepared_at_iso']}")
print(f"END_ISO={iso(end_epoch)}")
print(f"DURATION_SECONDS={duration}")
print(f"DURATION_HUMAN={hours:02d}:{minutes:02d}:{seconds:02d}")
print(f"RESULT_PATH={result_path}")
PY
