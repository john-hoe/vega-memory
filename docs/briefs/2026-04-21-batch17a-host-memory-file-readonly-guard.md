# Batch 17a — Host memory file read-only guard (P8-030.1-.4 closure)

## Context

P8-030 (Wave 5) enforces the read-only invariant on host memory files. Vega must never write to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.cursor/rules/memory.mdc`, or the other host surfaces — it only *indexes* them.

Two enforcement layers:
- **Lint-time** (CI): ESLint `no-restricted-syntax` in existing config, scoped via `overrides` to `src/retrieval/sources/host-memory-file*.ts`. Blocks `fs.write*`, `fs.appendFile*`, `fsp.write*`, `fsp.appendFile*`, `open(..., 'w'...)`.
- **Runtime** (unit-test invariant): public API shape test — `HostMemoryFileAdapter` exposes only `search`, `refreshIndex`, `dispose`. No `write*` / `append*` / `set*` methods.

## Scope

### 1. `.eslintrc.cjs` (or existing ESLint config) — add override

Find the existing ESLint config file. Add an `overrides` entry:
```js
overrides: [
  // ...existing overrides...
  {
    files: [
      "src/retrieval/sources/host-memory-file.ts",
      "src/retrieval/sources/host-memory-file-fts.ts",
      "src/retrieval/sources/host-memory-file-paths.ts",
      "src/retrieval/sources/host-memory-file-parser.ts"
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(writeFile|writeFileSync|appendFile|appendFileSync|write|rm|rmSync|unlink|unlinkSync|mkdir|mkdirSync|copyFile|copyFileSync|rename|renameSync|chmod|chmodSync|chown|chownSync|truncate|truncateSync|createWriteStream)$/]",
          message: "Host memory files are read-only. Vega never writes to host memory paths (P8-030 invariant)."
        }
      ]
    }
  }
]
```

If there is no existing ESLint config in the repo, create `.eslintrc.cjs` at repo root with a minimal config that extends any existing lint expectations (if `package.json` has `eslint` devDep but no config, codex chooses the smallest working config that enforces only the override above + inherits from `eslint:recommended`). Do NOT add broad new lint rules for other files.

### 2. `src/retrieval/sources/host-memory-file.ts` — TypeScript-level type guarantee

Export a `HostMemoryFileReader` interface (read-only public contract):
```ts
export interface HostMemoryFileReader {
  search(input: SearchInput): ReadonlyArray<SourceRecord>;
  refreshIndex(): { paths_indexed: number; duration_ms: number };
  dispose(): void;
}
```
`HostMemoryFileAdapter` class must `implements HostMemoryFileReader`. This pins the public shape at compile-time: future additions of write methods would break the interface contract, surfacing the violation early.

Do NOT break existing uses — only add the interface and `implements` clause; don't rename methods.

### 3. New `docs/architecture/host-memory-file-readonly-guarantee.md`

Required sections (grep-checkable):
1. `## Invariant` — statement: "Vega never writes to host memory files."
2. `## Why` — rationale (host owns its memory files; Vega is a reader/indexer; mixing write would break user trust + audit separation).
3. `## Enforcement` — two layers:
   - Lint: `.eslintrc.cjs` override on `src/retrieval/sources/host-memory-file*.ts` blocks fs write/rm/append calls.
   - Runtime: `HostMemoryFileReader` interface; `HostMemoryFileAdapter implements HostMemoryFileReader` pins public API at compile time. Unit test asserts the instance exposes no `write*` / `append*` / `set*` / `delete*` methods.
4. `## Exceptions` — none today; if ever needed (e.g. user-invoked action to clear stale local index), it must route through a separate adapter/module, NOT through `HostMemoryFileAdapter`. Document the pattern.
5. `## Related` — cross-reference P8-028 adapter + `docs/adapters/host-memory-file.md`.

### 4. `src/tests/host-memory-file-readonly-guard.test.ts` (new) — 3+ tests

- **Runtime API shape**: instantiate `HostMemoryFileAdapter` (with stub DB + tmp homeDir), reflect public methods. Assert it has exactly `search`, `refreshIndex`, `dispose`. Assert `typeof (adapter as any).writeFile === "undefined"`, same for `appendFile`, `write`, `remove`, `set*` patterns.
- **Type contract**: import the `HostMemoryFileReader` interface; verify `HostMemoryFileAdapter` assignable to it via a type-level `satisfies` assertion — compile time ensures this, but a runtime test that calls only the interface methods confirms the shape aligns. Include a comment explaining the compile-time guarantee.
- **Static source-scan fallback**: grep the 4 host-memory-file source files for forbidden write APIs (`fs.writeFile`, `fs.appendFile`, `fs.rm`, etc.) using `fs.readFileSync` + regex. Assert zero matches — if ESLint is misconfigured or bypassed, this runtime test still catches regressions.

All tests hermetic: `:memory:` SQLite + `mkdtempSync` tmp HOME. NO modification of real host memory files.

### 5. `src/tests/host-memory-file-eslint.test.ts` (new, optional but recommended) — 1 test

If ESLint CLI is available (check `require.resolve("eslint")` succeeds), run `eslint --max-warnings=0` against the 4 host-memory-file source files programmatically. Assert exit code 0 AND no violations reported. If ESLint not installed, skip with a `console.warn` and do not fail.

## Out of scope — do NOT touch

- `src/reconciliation/**`, `src/monitoring/vega-metrics.ts`, `metrics-fingerprint.ts`, `metrics.ts`, `dashboards/**`
- `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/alert/**`, `src/backup/**`, `src/timeout/**`, `src/checkpoint/**`
- `src/retrieval/sources/host-memory-file*.ts` EXCEPT `host-memory-file.ts` (add `HostMemoryFileReader` interface + `implements` only; don't change method bodies)
- `src/mcp/server.ts`, `src/api/server.ts`, `src/api/mcp.ts`, `src/index.ts`
- `src/db/migrations/**`, `src/core/contracts/**`
- All existing tests except 2 new guard test files
- Root-level markdown files

## Forbidden patterns (Wave 5 全程继续)

- Production 代码不得嗅探测试环境
- 测试不得触碰 macOS 真实钥匙串 / 真实 HOME / 真实 user config
- 不 amend `d1db0be` / `79751eb`; 新起 commit
- ESLint override scope MUST stay on the 4 listed files only — no broad lint changes to rest of repo
- Test must NOT actually write to real host memory paths — the regression test reads the source files, not the configured host paths

## Acceptance criteria

1. ESLint config (existing or new `.eslintrc.cjs`) contains `no-restricted-syntax` override targeting 4 host-memory-file source files
2. `rg -n "no-restricted-syntax" .eslintrc*` ≥ 1 hit in the config
3. `src/retrieval/sources/host-memory-file.ts` exports `HostMemoryFileReader` interface; `HostMemoryFileAdapter implements HostMemoryFileReader`
4. `docs/architecture/host-memory-file-readonly-guarantee.md` exists with 5 section headings (each ≥ 1 match)
5. `src/tests/host-memory-file-readonly-guard.test.ts` exists with ≥ 3 cases
6. Static source-scan test greps 4 host-memory-file files for `fs.writeFile|fs.appendFile|fs.rm|fs.unlink|fs.mkdir|fs.copyFile|fs.rename|fs.chmod|fs.chown|fs.truncate|createWriteStream` — zero matches
7. `git diff HEAD --name-only` limited to: ESLint config file, `src/retrieval/sources/host-memory-file.ts` (interface addition), `docs/architecture/host-memory-file-readonly-guarantee.md`, 1-2 new test files
8. `git diff HEAD -- src/reconciliation/ src/monitoring/ dashboards/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/backup/ src/timeout/ src/checkpoint/ src/retrieval/sources/host-memory-file-paths.ts src/retrieval/sources/host-memory-file-parser.ts src/retrieval/sources/host-memory-file-fts.ts src/retrieval/profiles.ts src/retrieval/ranker-score.ts src/retrieval/orchestrator.ts src/db/migrations/ src/core/contracts/ src/api/server.ts src/mcp/server.ts` outputs empty
9. `git diff HEAD -- src/tests/` shows only the 1-2 new guard test files
10. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1147 pass / 0 fail (1144 + 3-4 new)
11. If `npm run lint` exists, `set -o pipefail; npm run lint` exits 0
12. Not-amend: new commit stacked on HEAD
13. Commit title prefix `feat(guard):`
14. Commit body:
    ```
    Ships the host-memory-file read-only guard P8-030.1-.4:
    - ESLint override in .eslintrc.cjs scoped to the 4 host-memory-file
      source files; no-restricted-syntax blocks fs.write*/append*/rm/unlink/
      mkdir/copy/rename/chmod/chown/truncate/createWriteStream, failing lint
      if any future change adds a write path.
    - HostMemoryFileReader interface in src/retrieval/sources/host-memory-
      file.ts; HostMemoryFileAdapter implements it. Compile-time type
      assertion pins the read-only public API (search/refreshIndex/dispose).
    - docs/architecture/host-memory-file-readonly-guarantee.md: invariant /
      why / enforcement (two layers) / exceptions (none) / related.
    - Runtime guard tests: public-method reflection asserts the adapter
      exposes no write/append/set/delete methods; static source-scan as a
      belt-and-braces backup in case lint is bypassed.

    Scope: zero touches to reconciliation / monitoring / scheduler / notify
    / sunset / alert / backup / timeout / checkpoint / non-host host-memory
    files / api server / mcp server. ESLint override stays narrow.

    Scope-risk: minimal
    Reversibility: clean
    ```

## Review checklist

- Does the ESLint override apply ONLY to the 4 host-memory-file files (not all of src/)?
- Does `HostMemoryFileAdapter implements HostMemoryFileReader` compile without method renaming?
- Does the runtime reflection test assert `typeof adapter.writeFile === "undefined"` explicitly?
- Does the static source-scan test cover all 4 files + all forbidden fs APIs?
- Are ESLint violations fatal (`"error"` severity, not `"warn"`)?
- Does the new commit stack on `79751eb` (not an amend)?

## Commit discipline

- Single atomic commit, new stack on HEAD
- Prefix `feat(guard):`
- Body per Acceptance #14
- No root-level markdown / other docs except `docs/architecture/host-memory-file-readonly-guarantee.md`
