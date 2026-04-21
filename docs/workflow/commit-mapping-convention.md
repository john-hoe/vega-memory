# Phase 8 Commit Mapping Convention

Use these rules when mapping Git commits, briefs, GitHub items, and Notion rows for Phase 8 work.

1. Every code commit title must use the conventional format `<type>(<scope>): <subject>`, and the scope should match the Phase 8 area being changed.
2. Every code commit body must include `Scope-risk: <none|low|moderate|high>` and `Reversibility: <clean|moderate|hard>` so review and rollback cost stay visible in the history.
3. The Notion row `GitHub/Commit 链接` column should store the primary commit SHA for the task; if the task spans multiple commits, store the final `SEAL` commit SHA instead of an intermediate one.
4. Brief files live under `docs/briefs/YYYY-MM-DD-batchXX-<slug>.md`, and each closed batch should archive its brief with a `docs(briefs):` commit after the implementation batch is complete.
5. Tie-break rules: if a task is partially complete, map only the commit that closed a reviewable acceptance slice; if a task needs several implementation commits plus one verification closeout, map the final verified closeout or `SEAL` commit; if a docs-only follow-up lands after a code closeout, keep the code closeout SHA as the primary Notion mapping unless the docs commit is the explicit `SEAL`.
