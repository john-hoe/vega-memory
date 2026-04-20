## Invariant

Vega never writes to host memory files.

`HostMemoryFileAdapter` is a retrieval/indexing adapter for host-managed memory surfaces such as `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.cursor/rules/memory.mdc`, and `~/.omc/notepad.md`. Its contract is read-only.

## Why

The host owns these memory files, not Vega. Vega is responsible for discovery, parsing, indexing, and search over those files so retrieval can use them without taking over authorship.

Allowing writes through the same adapter would blur ownership, weaken auditability, and break user trust. Read-only access preserves a clean separation between host-managed memory and Vega-managed side indexes.

## Enforcement

Two layers enforce the read-only guarantee.

First, `.eslintrc.cjs` applies a narrow `no-restricted-syntax` override to `src/retrieval/sources/host-memory-file.ts`, `src/retrieval/sources/host-memory-file-fts.ts`, `src/retrieval/sources/host-memory-file-paths.ts`, and `src/retrieval/sources/host-memory-file-parser.ts`. That override blocks write-oriented fs calls such as `writeFile`, `appendFile`, `rm`, `unlink`, `mkdir`, `copyFile`, `rename`, `chmod`, `chown`, `truncate`, and `createWriteStream`.

Second, `src/retrieval/sources/host-memory-file.ts` exports `HostMemoryFileReader`, and `HostMemoryFileAdapter implements HostMemoryFileReader`. This pins the intended public API to `search`, `refreshIndex`, and `dispose` at compile time. Runtime guard tests reflect the instance shape and assert there are no `write*`, `append*`, `set*`, or `delete*` methods, plus a static source scan over the four host-memory-file source files.

## Exceptions

There are no exceptions today.

If Vega ever needs a user-invoked cleanup action, such as clearing a stale local side index, that work must go through a separate adapter or module. It must not be added to `HostMemoryFileAdapter`, because that would mix host-file mutation into a read-only retrieval surface.

## Related

- P8-028 host-memory-file adapter work
- [Host memory file adapter](../adapters/host-memory-file.md)
