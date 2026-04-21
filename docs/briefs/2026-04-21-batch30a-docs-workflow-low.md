# Batch 30a — Docs/workflow LOW: #53 stage.yml label + #54 SDK import paths + #48 example-repo truth

## Context

Three LOW-severity Phase 8 audit issues. Bundled because all three are docs/template-only. No production code changes.

**#53** — `.github/ISSUE_TEMPLATE/stage.yml` uses literal `stage-<N>` as `labels:` metadata. GitHub issue forms don't template-substitute `<N>` at submission time, so every issue created via the UI gets the literal label `stage-<N>` rather than `stage-0`..`stage-6`. Diverges from `docs/workflow/github-labels.json` + `tools/github/create-stage-issues.sh` which use the real labels.

**#54** — `docs/guides/host-integration/*.md` + `docs/examples/*/README.md` snippets use a repo-relative SDK source import. Correct shape is package import: `import { VegaClient } from "vega-memory"`. Current state misleads adopters.

**#48** — Notion task tracker marks P8-041.5 as ✅ but the deliverable was doc-only blueprint (per 21a brief scope). Fix: update docs/examples/*/README.md to be very explicit that these are blueprints (not runnable), and close the Notion-vs-deliverable mismatch by either (a) shipping a minimal runnable example OR (b) downgrading the Notion row to "doc-only blueprint, runnable repo deferred".

Pick (b) — truthful labeling. Runnable example repo is a real feature that belongs in a separate batch (potentially overlapping with B10 Python SDK). Scope clarification gets us consistent docs today.

No amend — new commit on HEAD (parent = `5ab1c92`).

## Scope

### 1. #53 — `.github/ISSUE_TEMPLATE/stage.yml` label fix

Current (broken) pattern:
```yaml
title: "[S<N>] <Stage name>"
labels:
  - "stage-<N>"  # not template-substituted by GitHub
```

Fix: remove the literal `stage-<N>` from `labels:` metadata. Add a required dropdown field for stage number, and document in the form body that the canonical label must be applied by `tools/github/create-stage-issues.sh` OR manually after create:

```yaml
name: Stage issue (S0-S6)
description: File a stage-level tracking issue for Vega Phase 8+ pipeline stages.
title: "[S<N>] <Stage name>"
labels:
  - phase-8-audit  # workflow marker; exact stage label applied post-create
body:
  - type: dropdown
    id: stage_number
    attributes:
      label: Stage number
      description: Which pipeline stage does this issue track?
      options:
        - "S0 (contracts + ingestion)"
        - "S1 (retrieval)"
        - "S2 (promotion)"
        - "S3 (wiki)"
        - "S4 (fact-claim)"
        - "S5 (graph)"
        - "S6 (archive)"
    validations:
      required: true
  - type: input
    id: p8_task_links
    attributes:
      label: P8-NNN task references
      description: Comma-separated list of Notion P8 task IDs.
      placeholder: "P8-037, P8-038.5"
  - type: input
    id: milestone
    attributes:
      label: Milestone
      description: Target milestone / sprint / phase.
  - type: textarea
    id: acceptance_criteria
    attributes:
      label: Acceptance criteria
      description: Bullet list of conditions that close this issue.
      placeholder: "- [ ] ..."
    validations:
      required: true

# NOTE: GitHub issue forms cannot template-substitute <N> into labels:.
# The stage-<N> label must be applied by tools/github/create-stage-issues.sh
# or added manually post-create.
```

Remove broken `stage-<N>` from labels. Keep `phase-8-audit` for workflow tracking.

Add a note at the top of the form body (HTML comment or Markdown field) explaining the post-create label step.

### 2. #54 — SDK import path fix across 4 docs files

Files:
- `docs/guides/host-integration/README.md` lines 5-10
- `docs/examples/claude-code-example/README.md` lines 17-36
- `docs/examples/cursor-example/README.md` lines 17-37
- `docs/examples/opencode-example/README.md` lines 17-37

For each: replace the repo-relative SDK source import (or similar) with `import { VegaClient } from "vega-memory"`.

Also update the paragraph context so the reader is told:
1. `npm install vega-memory` (already there)
2. `import { VegaClient } from "vega-memory"` (correct package entrypoint)

No type changes; pure doc text.

### 3. #48 — `docs/examples/*/README.md` truthful framing

For `docs/examples/README.md` + `docs/examples/claude-code-example/README.md` + `docs/examples/cursor-example/README.md` + `docs/examples/opencode-example/README.md`:

Add a prominent disclaimer at the TOP:

```md
> **Blueprint only** — this directory contains architecture sketches, directory
> layouts, and configuration file shapes. It does NOT contain runnable code.
> Runnable example repositories are a separate deliverable (not shipped as of
> 2026-04-21). Use these blueprints to scaffold an integration; do not expect
> `npm install` + `npm run` to work from here.
```

Same or similar wording at the top of each of the 4 files. Text should be unambiguous enough that the Notion P8-041.5 row can truthfully reference this framing.

### 4. #53 workflow regression check

Add a tiny test OR doc-check script that prevents re-introduction of `stage-<N>` literal in `.github/ISSUE_TEMPLATE/*.yml`:

Either:
- `src/tests/github-issue-templates.test.ts` (new) — ≥ 1 case: reads the yaml, asserts no literal `<N>` or `<stage>` placeholders in `labels:` fields
- OR a `tools/github/lint-templates.sh` bash script with the same check, runnable manually

Preferred: ts test for automation.

### 5. #54 regression check

Add to the same new test file (or a new one): scan `docs/guides/host-integration/*.md` + `docs/examples/**/*.md` for repo-relative SDK source imports. Assert 0 matches.

### 6. Notion update reminder

Add a note to `docs/briefs/2026-04-21-batch30a-docs-workflow-low.md` (this brief) final section: "Notion row P8-041.5 description should be updated to 'doc-only blueprint; runnable example repo deferred'. This brief's commit does not include the Notion patch (Notion updates happen in B13 batching)."

## Out of scope — do NOT touch

- Everything source-code: `src/**` EXCEPT the new test file
- `src/sdk/` (don't change the SDK to make the import path match; fix the docs instead)
- `package.json`, `.eslintrc.cjs`, `docs/adapters/canary-rollout.md`, `docs/architecture/*`
- All other briefs, all other workflow files
- `tools/github/create-stage-issues.sh` + `tools/github/sync-labels.sh` (already correct; script-side applies real labels)
- `docs/workflow/github-labels.json` (canonical registry; don't touch)

Allowed:
- `.github/ISSUE_TEMPLATE/stage.yml` (rewrite per #53 fix)
- `docs/guides/host-integration/README.md` + `{claude-code,cursor,opencode}.md` (import path + any other repo-relative SDK source import patterns)
- `docs/examples/README.md` + 3 subdir READMEs (blueprint disclaimer + import path)
- `src/tests/github-issue-templates.test.ts` (new; regression check)
- `docs/briefs/2026-04-21-batch30a-docs-workflow-low.md` (this file — include Notion reminder)

## Forbidden patterns

- NO amend of prior commits — new commit on HEAD (parent = `5ab1c92`)
- NO production code changes (pure docs/templates this batch)
- NO changes to `src/sdk/**` to "make the import path work" — fix docs to match the real package entrypoint
- Blueprint disclaimer MUST be unambiguous ("NOT runnable", "do NOT expect npm run to work")
- Issue form MUST NOT silently keep the `stage-<N>` label even as a comment (strip entirely)

## Acceptance criteria

1. `rg -n "stage-<N>" .github/` = 0 (literal placeholder gone)
2. `rg -nE '^\\s+- type: dropdown' .github/ISSUE_TEMPLATE/stage.yml` ≥ 1 (dropdown form field for stage number added)
3. `rg -n -e 'repo-relative SDK source import sentinel' docs/` should find only this brief note; no guides/examples docs should retain repo-relative SDK source imports.
4. `rg -n 'from "vega-memory"' docs/guides/host-integration/` ≥ 1 (package import present in at least one guide)
5. `rg -nE "^> \\*\\*Blueprint only" docs/examples/` ≥ 4 (disclaimer at top of 4 files)
6. `src/tests/github-issue-templates.test.ts` exists; `rg -c "^test\\(" src/tests/github-issue-templates.test.ts` ≥ 2 (at least: "no <N> placeholder in labels" + "no repo-relative sdk import in docs")
7. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1255 pass / 0 fail (1253 + 2 new)
8. `npm run lint:readonly-guard` exits 0
9. Not-amend; parent of new commit = `5ab1c92`
10. Commit title prefix `docs(workflow):` OR `fix(docs):`
11. Commit body:
    ```
    Close docs/workflow audit LOW findings #53 + #54 + #48.

    #53 stage.yml label:
    - .github/ISSUE_TEMPLATE/stage.yml: removed literal stage-<N>
      placeholder from labels metadata (GitHub issue forms do not
      template-substitute <N>); added a required dropdown for
      stage number selection; documented that the canonical stage-<N>
      label must be applied post-create via tools/github/create-stage-
      issues.sh or manually.

    #54 SDK import paths:
    - docs/guides/host-integration/README.md + claude-code/cursor/
      opencode.md + docs/examples/*/README.md: changed 
      repo-relative SDK imports to package-accurate 
      "vega-memory" entry.

    #48 blueprint disclaimer:
    - docs/examples/README.md + 3 subdir READMEs: added prominent
      "Blueprint only" disclaimer at top. Makes the deliverable-vs-
      tracker truth explicit (runnable example repo deferred).
      Notion P8-041.5 row should be updated to match — planned in
      B13 Notion housekeeping batch.

    Regression:
    - src/tests/github-issue-templates.test.ts (≥ 2 cases): scans
      .github/ISSUE_TEMPLATE for <N> placeholders in labels; scans
      docs/guides + docs/examples for repo-relative SDK imports.

    Scope: 8 docs files + 1 new test + 1 issue template. Zero
    production code changes.

    Scope-risk: minimal (docs/templates only)
    Reversibility: clean
    ```

## Review checklist

- stage-<N> literal really removed from labels (grep = 0)?
- Dropdown form field actually validates (GitHub schema compliance)?
- Blueprint disclaimer in all 4 example READMEs at TOP?
- Package import `"vega-memory"` used in docs (not just dropped)?
- New regression tests actually assert both checks?
- New commit stacks on `5ab1c92` (not amend)?

## Commit discipline

- Single atomic commit
- Prefix `docs(workflow):` OR `fix(docs):`
- Body per Acceptance #11
- Files changed: 1 `.github/ISSUE_TEMPLATE/stage.yml` + 4 guide docs + 4 example READMEs + 1 new test file

## Notion reminder (for B13 housekeeping)

After this batch lands, Notion row P8-041.5 should get:
- Status: ✅ → ✅ (no change)
- Description: "Doc-only blueprint shipped; runnable example repo explicitly deferred to future phase per 21a + 30a scope"
- GitHub/Commit 链接: commit link to this batch's seal (will be known post-commit)

Don't perform the Notion update in this batch — batch it with other tracker housekeeping in B13.

Notion row P8-041.5 description should be updated to "doc-only blueprint; runnable example repo deferred". This brief's commit does not include the Notion patch (Notion updates happen in B13 batching).
