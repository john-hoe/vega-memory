# Phase 8 Code Review Rubric

Use this rubric for Phase 8 review comments, PR verdicts, and SEAL passes. Review output should cite the brief, the affected byte-locks, and the exact file paths that prove the concern.

## Severity levels

- `HIGH` blocks merge. Use it for correctness defects, scope breaches against the approved brief, byte-lock violations, missing required verification, contract drift, migration drift, or rollback gaps that can break Phase 8 behavior.
- `MEDIUM` should be fixed before SEAL unless the reviewer explicitly accepts the residual risk. Use it for incomplete docs, weak guard rails, partial validation, or maintainability issues that can mislead later batches.
- `LOW` is advisory. Use it for clarity improvements, wording cleanup, or non-blocking consistency issues that do not change the Phase 8 risk profile.

## What earns each

- `HIGH`
  - A PR changes a protected path that the brief marked byte-locked.
  - Build, tests, or required focused checks were not run fresh.
  - Acceptance criteria are not fully implemented, but the PR claims the stage is ready.
  - Commit mapping or Notion sync rules are skipped for a closing batch.
- `MEDIUM`
  - The implementation works, but the PR template leaves known gaps or rollback notes blank.
  - A script is not clearly idempotent or does not explain the safe rerun behavior.
  - Naming or structure obscures which Phase 8 task or stage the change belongs to.
- `LOW`
  - Headings, checklist wording, or placeholder examples can be clearer.
  - Descriptions are inconsistent with nearby workflow docs but do not change behavior.
  - The reviewer has a simplification suggestion that can land in a later cleanup batch.

## Verdict format

- `PASS` means no blocking findings remain and the PR is ready once the recorded checks stay green.
- `BLOCK` means at least one `HIGH` finding remains, or required evidence is missing.
- `SEAL PASS` means the PR passed review and the final commit is the canonical commit to map back to Notion for a multi-commit task.

## Reviewer output template

```md
# Review Verdict: {{PASS|BLOCK|SEAL PASS}}

## Brief

- Brief: `{{docs/briefs/YYYY-MM-DD-batchXX-slug.md}}`
- Stage / batch: `{{S0-S6 or batch id}}`

## Findings

- `{{HIGH|MEDIUM|LOW}}` - [{{path}}]({{/abs/path/to/file}}:{{line}})
  - Concern: `{{what is wrong}}`
  - Why it matters: `{{brief, byte-lock, or verification impact}}`
  - Required action: `{{fix or follow-up}}`

## Verification evidence

- Build: `{{command + result}}`
- Tests: `{{command + pass/fail counts}}`
- Focused checks: `{{grep, diff, or script output}}`

## Residual risks

- `{{known gap or none}}`
```
