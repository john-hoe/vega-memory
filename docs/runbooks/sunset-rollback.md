## When to rollback a sunset

Rollback a sunset when the decision is reversed, real usage rebounds above expectations, or stakeholders push back on retiring the endpoint.

## Rollback procedure

1. Remove the candidate entry from `docs/sunset-registry.yaml`.
2. Revert any `CHANGELOG.md` lines that referenced the rolled-back candidate if you want a clean changelog; otherwise leave them as historical context.
3. Re-deploy.

## Verify rollback

Run `sunset.check` and confirm the candidate is no longer listed, then verify the restored route metrics or flags reflect the rollback.

## Post-mortem checklist

Document why the sunset criteria were premature and adjust future `usage_threshold` or `time_based` values before proposing another sunset.
