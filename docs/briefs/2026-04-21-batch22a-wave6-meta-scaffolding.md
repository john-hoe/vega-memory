# Batch 22a — Wave 6 meta scaffolding (P8-038.5 + P8-039.1-.5 + P8-040.1-.5 closure)

## Context

Phase 8 Wave 6 is project/process infrastructure. Earlier work already completed most of it:
- **P8-037** (Phase 8 spec) — already ✅ (Notion page exists)
- **P8-038.1-.4** — the Notion task DB itself (170 rows maintained) + `GitHub/Commit 链接` URL column already in place (commit mapping convention implicit).

This batch closes the remaining scaffolding:
- **P8-038.5** — Weekly status template (markdown)
- **P8-039.1-.5** — GitHub stage issues S0-S6 scaffold (issue template YAML + label config + creation script)
- **P8-040.1-.5** — PR brief templates (S0 + S1) + PR review checklist + code review rubric + pre-merge verification playbook

Ship templates + scripts as committed repo files. Actual GitHub API calls (creating issues, labels) are OUT of scope for this batch — user runs scripts when ready.

## Scope

### 1. `docs/workflow/weekly-status-template.md` (P8-038.5)

Required sections (grep-checkable):
1. `## Shipped this week` — commits / batches closed.
2. `## In progress` — batches started, blocked items.
3. `## Upcoming` — planned next week.
4. `## Metrics snapshot` — core 5 + test count + reconciliation findings delta.
5. `## Risks & asks` — anything blocking or needs user decision.

Format: markdown template with `{{}}` placeholders users fill in.

### 2. `.github/ISSUE_TEMPLATE/stage.yml` (P8-039.1)

GitHub issue form template (YAML format per GitHub spec):
- Title: `[S<N>] <Stage name>`
- Fields:
  - `stage_number` (S0-S6)
  - `p8_task_links` (textarea for P8-NNN references)
  - `milestone`
  - `acceptance_criteria`
- Labels auto-applied: `stage-<N>`.

### 3. `docs/workflow/github-labels.json` (P8-039.3)

Canonical label registry (JSON array):
- `wave-1` through `wave-6`
- `stage-0` through `stage-6`
- `priority-p0` / `-p1` / `-p2` / `-p3`
- `round-1` / `round-2`

Each entry: `{name, color, description}`.

### 4. `tools/github/create-stage-issues.sh` (P8-039.5)

Bash script that calls `gh issue create` for each of the 7 stages (S0-S6), using `.github/ISSUE_TEMPLATE/stage.yml` body + pre-filled title + labels. Idempotent: checks if an issue with the stage title already exists via `gh issue list`, skips if present. Exits 0 on success.

Does NOT run automatically — user invokes manually: `bash tools/github/create-stage-issues.sh`.

### 5. `tools/github/sync-labels.sh` (P8-039.3 complement)

Bash script that reads `docs/workflow/github-labels.json` and calls `gh label create` or `gh label edit` for each. Idempotent.

### 6. `.github/PULL_REQUEST_TEMPLATE/s0.md` + `.github/PULL_REQUEST_TEMPLATE/s1.md` (P8-040.1 + P8-040.2)

S0 (contracts + ingestion) + S1 (retrieval 主脑) PR brief templates. Each has:
- ## Stage overview
- ## Acceptance criteria (checkbox list)
- ## Scope — files touched + byte-locks
- ## Testing — what must pass before merge
- ## Rollback — how to revert if needed
- ## Related P8 tasks (comma-separated IDs)

### 7. `.github/PULL_REQUEST_TEMPLATE/default.md` (P8-040.3 PR review checklist)

Generic PR review checklist template with 10-15 standard checks:
- [ ] Tests added / updated?
- [ ] Build + test green locally?
- [ ] Scope matches brief?
- [ ] Commit message follows `<type>(<scope>): <subject>` convention?
- [ ] Byte-locked files untouched?
- [ ] Known gaps documented?
- [ ] Related Notion task updated?
...

### 8. `docs/workflow/code-review-rubric.md` (P8-040.4)

Code review severity rubric. Required sections:
1. `## Severity levels` — HIGH / MEDIUM / LOW definitions.
2. `## What earns each` — examples per level.
3. `## Verdict format` — PASS / BLOCK / SEAL PASS.
4. `## Reviewer output template` — markdown template.

### 9. `docs/workflow/pre-merge-verification.md` (P8-040.5)

Checklist of required pre-merge verifications:
1. `## Build` — `npm run build` exits 0.
2. `## Tests` — `npm test` 100% pass.
3. `## Lint` — if lint script exists, passes.
4. `## Byte-locks` — `git diff <base>...HEAD` verify no changes to protected paths.
5. `## Notion + GitHub sync` — Notion row status matches commit; GitHub issue linked.
6. `## Performance baseline` — p95 latency ≤ +10% from baseline (if perf-sensitive change).

### 10. `docs/workflow/commit-mapping-convention.md` (P8-038.4 explicit codification)

Document the existing convention:
1. Every code commit title prefix: `<type>(<scope>): <subject>` per conventional commits.
2. Every code commit body includes: `Scope-risk: <none|low|moderate|high>` + `Reversibility: <clean|moderate|hard>`.
3. Notion row's `GitHub/Commit 链接` column gets the PRIMARY commit SHA; multi-commit tasks use the SEAL commit (last).
4. Brief files live in `docs/briefs/YYYY-MM-DD-batchXX-<slug>.md`; each brief committed via `docs(briefs):` archive commit after batch close.
5. Tie-break rules for multi-commit + partial completion scenarios.

## Out of scope — do NOT touch

- All of `src/**` (Wave 6 is pure docs + workflow)
- All prior byte-locked production paths
- `.eslintrc.cjs`, `src/db/migrations/**`, `src/core/contracts/**`
- All existing tests (no new tests in this batch)
- Actual `gh` CLI execution (user runs scripts manually)

## Forbidden patterns

- No amend of e7a2787 / 4c398b5 / eb9f659; new commit on HEAD
- Templates MUST be self-contained (no external service auth required to render them)
- `gh`-invoking scripts MUST be idempotent (safe to run multiple times)
- No commits or pushes to GitHub from this batch's scripts — those run under user invocation

## Acceptance criteria

1. `docs/workflow/weekly-status-template.md` exists with 5 section headings
2. `.github/ISSUE_TEMPLATE/stage.yml` exists with valid GitHub issue form schema
3. `docs/workflow/github-labels.json` exists with ≥ 14 label entries (wave-1-6 + stage-0-6 + priority + round)
4. `tools/github/create-stage-issues.sh` + `sync-labels.sh` exist; both are executable (`chmod +x`)
5. `.github/PULL_REQUEST_TEMPLATE/s0.md` + `s1.md` + `default.md` each have the required sections listed
6. `docs/workflow/code-review-rubric.md` has 4 section headings
7. `docs/workflow/pre-merge-verification.md` has 6 section headings
8. `docs/workflow/commit-mapping-convention.md` has 5 numbered rules
9. `git diff HEAD --name-only | grep -c '^src/'` = 0 (zero src/ changes)
10. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1190 pass / 0 fail (no test changes)
11. Not-amend; new commit on HEAD
12. Commit title prefix `docs(workflow):` (this batch is pure docs/scripts)
13. Commit body:
    ```
    Ships Wave 6 meta scaffolding P8-038.5 + P8-039.1-.5 + P8-040.1-.5:
    - docs/workflow/{weekly-status-template,code-review-rubric,
      pre-merge-verification,commit-mapping-convention}.md: template
      suite for weekly reporting, review rubric, pre-merge checklist,
      commit↔Notion mapping conventions.
    - .github/ISSUE_TEMPLATE/stage.yml: GitHub issue form for
      stage-level tracking (S0-S6), auto-labels stage-<N>.
    - docs/workflow/github-labels.json: 14+ canonical labels
      (wave-1-6, stage-0-6, priority-p0-p3, round-1-2).
    - tools/github/{create-stage-issues,sync-labels}.sh:
      idempotent bash scripts invoking gh CLI. User runs manually.
    - .github/PULL_REQUEST_TEMPLATE/{s0,s1,default}.md: S0 contracts
      + S1 retrieval + default review checklist templates.

    Scope: zero src/ changes; all docs + scripts. gh CLI execution
    remains user-invoked for safety (no automated GitHub state change
    from this batch).

    P8-038.1-.4 were implicitly closed earlier via Notion task DB
    maintenance (170 rows + 4 new columns for acceptance/verification/
    brief/commit links). P8-037 already ✅. This batch closes the rest
    of Wave 6.

    Scope-risk: minimal
    Reversibility: clean (delete template files; gh state unaffected)
    ```

## Review checklist

- Are all templates self-contained (no render-time external fetches)?
- Are bash scripts idempotent (check-then-create pattern)?
- Do templates reference Phase 8 conventions (not generic)?
- Does `default.md` PR template include 10-15 checkboxes?
- Is `github-labels.json` valid JSON (`jq` parseable)?
- New commit stacks on `4c398b5` (not amend)?

## Commit discipline

- Single atomic commit
- Prefix `docs(workflow):`
- Body per Acceptance #13
- No src/ changes; new dirs: `docs/workflow/`, `tools/github/`, `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE/`
