#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE_PATH="$ROOT_DIR/.github/ISSUE_TEMPLATE/stage.yml"

if [[ ! -f "$TEMPLATE_PATH" ]]; then
  echo "Missing issue template: $TEMPLATE_PATH" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required." >&2
  exit 1
fi

repo_flag=()
if [[ -n "${GH_REPO:-}" ]]; then
  repo_flag=(-R "$GH_REPO")
fi

existing_titles="$(gh issue list ${repo_flag[@]+"${repo_flag[@]}"} --state all --limit 500 --json title)"
stage_milestone="${STAGE_MILESTONE:-Phase 8}"

stage_rows=()
while IFS= read -r row; do
  [[ -n "$row" ]] && stage_rows+=("$row")
done <<'EOF'
S0	Contracts + ingestion	stage-0	P8-001, P8-002, P8-007, P8-010
S1	Retrieval main brain	stage-1	P8-015, P8-016, P8-028, P8-029, P8-031
S2	Storage and consolidation	stage-2	{{comma-separated P8 task ids}}
S3	API and MCP surfaces	stage-3	{{comma-separated P8 task ids}}
S4	Observability and reconciliation	stage-4	{{comma-separated P8 task ids}}
S5	Workflow and docs	stage-5	{{comma-separated P8 task ids}}
S6	SEAL and release hardening	stage-6	{{comma-separated P8 task ids}}
EOF

for row in "${stage_rows[@]}"; do
  IFS=$'\t' read -r stage_number stage_name label_name task_links <<<"$row"
  title="[$stage_number] $stage_name"

  if EXISTING_TITLES="$existing_titles" node -e '
const issues = JSON.parse(process.env.EXISTING_TITLES);
const title = process.argv[1];
process.exit(issues.some((issue) => issue.title === title) ? 0 : 1);
' "$title"; then
    echo "skip $title"
    continue
  fi

  body=$(cat <<EOF
Created from \`.github/ISSUE_TEMPLATE/stage.yml\`.

## Stage number

$stage_number

## P8 task links

- $task_links

## Milestone

$stage_milestone

## Acceptance criteria

- [ ] Scope stays aligned to the approved Phase 8 brief set for $stage_number.
- [ ] Protected and byte-locked paths are verified before merge.
- [ ] Build and test evidence is attached before the stage is closed.
- [ ] The final SEAL commit SHA is mapped to the Notion \`GitHub/Commit 链接\` field.
EOF
)

  gh issue create ${repo_flag[@]+"${repo_flag[@]}"} --title "$title" --label "$label_name" --body "$body" >/dev/null
  echo "create $title"
done
