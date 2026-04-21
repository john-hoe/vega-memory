# Phase 8 Pre-Merge Verification

Run this checklist before merging any Phase 8 batch or stage PR. Fresh evidence is required for every item that applies, and byte-locked paths must remain untouched unless the brief explicitly reopens them.

## Build

- Run `set -o pipefail; npm run build`.
- Record the exit code and keep the output available for the PR or review note.

## Tests

- Run `set -o pipefail; npm test`.
- Require 100 percent pass for the current suite before merge.
- If the brief names focused tests or grep checks, run them in addition to the full suite.

## Lint

- If `package.json` exposes a lint script, run it and record the result.
- If no lint script exists, note `lint: not configured in package.json` in the PR body instead of silently skipping it.

## Byte-locks

- Run `git diff <base>...HEAD --name-only` and compare the changed paths against the brief's forbidden or byte-locked paths.
- If the brief names exact protected paths, run the narrower diff command from the brief and require empty output.

## Notion + GitHub sync

- Confirm the Notion row status, brief link, and `GitHub/Commit 链接` field match the current PR or final SEAL commit.
- Confirm the related GitHub issue or stage issue references the same Phase 8 task IDs and current milestone.

## Performance baseline

- For perf-sensitive changes, confirm p95 latency stays within `+10%` of the recorded baseline before merge.
- If the batch is docs-only or workflow-only, record `not applicable` explicitly rather than leaving the section blank.
