#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABELS_FILE="$ROOT_DIR/docs/workflow/github-labels.json"

if [[ ! -f "$LABELS_FILE" ]]; then
  echo "Missing label registry: $LABELS_FILE" >&2
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

existing_labels="$(gh label list "${repo_flag[@]}" --limit 500 --json name,color,description)"

while IFS=$'\t' read -r action name color description; do
  case "$action" in
    create)
      gh label create "${repo_flag[@]}" "$name" --color "$color" --description "$description" >/dev/null
      echo "create $name"
      ;;
    edit)
      gh label edit "${repo_flag[@]}" "$name" --color "$color" --description "$description" >/dev/null
      echo "edit $name"
      ;;
    skip)
      echo "skip $name"
      ;;
    *)
      echo "Unknown action for $name: $action" >&2
      exit 1
      ;;
  esac
done < <(
  EXISTING_LABELS="$existing_labels" node - "$LABELS_FILE" <<'EOF'
const fs = require('fs');

const filePath = process.argv[2];
const desired = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const existing = JSON.parse(process.env.EXISTING_LABELS);

for (const label of desired) {
  if (!label.name || !label.color || !label.description) {
    throw new Error(`Invalid label entry: ${JSON.stringify(label)}`);
  }

  const current = existing.find((entry) => entry.name === label.name);

  if (!current) {
    console.log(['create', label.name, label.color, label.description].join('\t'));
    continue;
  }

  const sameColor = String(current.color || '').toLowerCase() === String(label.color).toLowerCase();
  const sameDescription = String(current.description || '') === String(label.description);

  if (sameColor && sameDescription) {
    console.log(['skip', label.name, label.color, label.description].join('\t'));
    continue;
  }

  console.log(['edit', label.name, label.color, label.description].join('\t'));
}
EOF
)
