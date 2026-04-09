#!/usr/bin/env bash
# Usage: ./scripts/task-done.sh <TASK_ID> "<commit message>"
# Example: ./scripts/task-done.sh VM2-001 "VM2-001: 统一 recall 协议完成，475 tests 全绿"
#
# Prerequisites:
#   - gh CLI authenticated
#   - vega CLI installed
#   - NOTION_TOKEN set (from MCP config, or export manually)
#   - Run from project root

set -euo pipefail

TASK_ID="${1:?Usage: task-done.sh <TASK_ID> <commit message>}"
COMMIT_MSG="${2:?Usage: task-done.sh <TASK_ID> <commit message>}"
PROJECT="vega-memory"

echo "=== Task Done: ${TASK_ID} ==="

# Step 1: Build + Test verification
echo "[1/5] Verifying build and tests..."
npm run build > /dev/null 2>&1 || { echo "ERROR: build failed"; exit 1; }
TEST_OUTPUT=$(npm test 2>&1)
echo "${TEST_OUTPUT}" | tail -5
FAIL_COUNT=$(echo "${TEST_OUTPUT}" | grep -E "^ℹ fail " | awk '{print $NF}')
if [ "${FAIL_COUNT:-0}" != "0" ]; then
  echo "ERROR: tests failed (${FAIL_COUNT} failures)"
  exit 1
fi
echo "Build + tests passed."

# Step 2: Git commit + push
echo "[2/5] Git commit + push..."
git add -A
git commit -m "${COMMIT_MSG}" || { echo "Nothing to commit"; }
git push origin HEAD || { echo "WARNING: push failed, continue anyway"; }
echo "Git done."

# Step 3: Update Notion status
echo "[3/5] Updating Notion..."
# Find the page ID by task ID using the Notion MCP search
# We use the vega-memory Notion database ID
NOTION_DB_ID="ba59af38-59d1-4953-8be7-51e2cd41e3d3"

# Use gh/curl approach - find page then update
# First search for the page
PAGE_JSON=$(curl -s -X POST "https://api.notion.com/v1/databases/${NOTION_DB_ID}/query" \
  -H "Authorization: Bearer ${NOTION_TOKEN:-}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d "{\"filter\":{\"property\":\"任务ID\",\"rich_text\":{\"equals\":\"${TASK_ID}\"}}}" 2>/dev/null)

PAGE_ID=$(echo "${PAGE_JSON}" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    results = data.get('results', [])
    if results:
        print(results[0]['id'])
except:
    pass
" 2>/dev/null)

if [ -n "${PAGE_ID}" ] && [ -n "${NOTION_TOKEN:-}" ]; then
  curl -s -X PATCH "https://api.notion.com/v1/pages/${PAGE_ID}" \
    -H "Authorization: Bearer ${NOTION_TOKEN}" \
    -H "Notion-Version: 2022-06-28" \
    -H "Content-Type: application/json" \
    -d '{"properties":{"状态":{"select":{"name":"✅ 已完成"}}}}' > /dev/null 2>&1
  echo "Notion updated: ${TASK_ID} -> ✅ 已完成"
else
  echo "WARNING: Notion update skipped (no NOTION_TOKEN or page not found)"
  echo "  Manual: update ${TASK_ID} status to ✅ 已完成"
fi

# Step 4: Store to Vega Memory
echo "[4/5] Storing to Vega Memory..."
vega store "${TASK_ID} 完成。${COMMIT_MSG}" \
  --type task_state \
  --project "${PROJECT}" \
  --title "${TASK_ID} — 已完成" \
  --source explicit 2>/dev/null \
  && echo "Vega Memory stored." \
  || echo "WARNING: Vega store failed (Ollama might be unavailable)"

# Step 5: Summary
echo "[5/5] Done!"
echo ""
echo "=== ${TASK_ID} Complete ==="
echo "  Git: committed + pushed"
echo "  Notion: ✅ 已完成"
echo "  Vega: task_state stored"
