# Phase 8 PR Review Checklist

## Review context

- Brief: `{{docs/briefs/YYYY-MM-DD-batchXX-slug.md}}`
- Stage or batch: `{{S0-S6 or batch id}}`
- Final mapping commit: `{{sha or SEAL sha}}`

## Scope & byte-locks

- Files touched:
  - `{{path}}`
  - `{{path}}`
- Protected or byte-locked paths checked:
  - `{{path or command}}`
  - `{{path or command}}`

## Review checklist

- [ ] Tests added or updated where the brief required them
- [ ] `set -o pipefail; npm run build` is green locally
- [ ] `set -o pipefail; npm test` is green locally
- [ ] Scope matches the approved Phase 8 brief
- [ ] Protected or byte-locked files stayed untouched unless explicitly reopened
- [ ] Commit title follows `<type>(<scope>): <subject>`
- [ ] Commit body includes `Scope-risk:` and `Reversibility:`
- [ ] Known gaps or deferred work are documented
- [ ] Rollback steps are documented
- [ ] Notion row status and `GitHub/Commit 链接` are ready to update
- [ ] Related GitHub issue or stage issue is linked
- [ ] No render-time external fetch is required for docs or templates in this PR

## Known gaps

- `{{gap or none}}`

## Related P8 tasks

`{{comma-separated P8 task ids}}`
