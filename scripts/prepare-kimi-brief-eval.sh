#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <brief-path>" >&2
  exit 1
fi

BRIEF_PATH="$1"

if [[ ! -f "$BRIEF_PATH" ]]; then
  echo "Brief not found: $BRIEF_PATH" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RESULT_ROOT="$ROOT_DIR/docs/briefs/kimi-2.6-eval"
LOG_ROOT="$RESULT_ROOT/logs"
BRIEF_BASENAME="$(basename "$BRIEF_PATH")"
TASK_ID="${BRIEF_BASENAME%.md}"
TASK_ID="${TASK_ID%-brief}"
TASK_DIR="$RESULT_ROOT/$TASK_ID"
RESULT_PATH="$TASK_DIR/result.md"
PROMPT_PATH="$TASK_DIR/prompt.txt"
META_PATH="$TASK_DIR/meta.json"

mkdir -p "$TASK_DIR" "$LOG_ROOT"

PREPARED_AT_EPOCH="$(date +%s)"
PREPARED_AT_ISO="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > "$META_PATH" <<EOF
{
  "task_id": "$TASK_ID",
  "brief_path": "$BRIEF_PATH",
  "result_path": "$RESULT_PATH",
  "prompt_path": "$PROMPT_PATH",
  "prepared_at_epoch": $PREPARED_AT_EPOCH,
  "prepared_at_iso": "$PREPARED_AT_ISO",
  "runner": "kimi-2.6"
}
EOF

cat > "$RESULT_PATH" <<EOF
# $TASK_ID Result

## task id

$TASK_ID

## changed files

- (to be filled by Kimi)

## commands run

- (to be filled by Kimi)

## acceptance criteria status

- (to be filled by Kimi)

## remaining risks

- (to be filled by Kimi)
EOF

cat > "$PROMPT_PATH" <<EOF
你现在要处理一份 brief。

Brief 路径：
$BRIEF_PATH

结果文件：
$RESULT_PATH

要求：
1. 先读取 brief 原文。
2. 不要扩 scope。
3. 不要修改原始 brief 文件。
4. 如果这是 [PLANNING] brief，只输出执行计划，不写代码。
5. 如果这是叶子 brief，就按 brief 执行。
6. 把最终结果写入：
   $RESULT_PATH
7. 最终结果必须包含：
   - task id
   - changed files
   - commands run
   - acceptance criteria status
   - remaining risks
8. 如果 brief 有歧义，先指出，再给出最小修正方案。
9. 不允许跳过验证命令，不允许假设测试通过。
EOF

cat <<EOF
Prepared Kimi eval task.
TASK_ID=$TASK_ID
BRIEF_PATH=$BRIEF_PATH
RESULT_PATH=$RESULT_PATH
PROMPT_PATH=$PROMPT_PATH
META_PATH=$META_PATH
LOG_PATH=$LOG_ROOT/$TASK_ID.log

Next step for Kimi:
1. Read $BRIEF_PATH
2. Follow the instructions in $PROMPT_PATH
3. Write the final result to $RESULT_PATH
4. Timing start is recorded in $META_PATH
EOF
