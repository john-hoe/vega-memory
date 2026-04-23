#!/usr/bin/env bash
set -euo pipefail

ESLINT_BIN="$(command -v eslint)"
PARSER="$(cd "$(dirname "$ESLINT_BIN")/.." && pwd)/@typescript-eslint/parser/dist/index.js"

find src -name "*.ts" -type f -print0 |
  xargs -0 "$ESLINT_BIN" \
    --no-eslintrc \
    --config .eslintrc.cjs \
    --resolve-plugins-relative-to node_modules \
    --parser "$PARSER"
