# Example Integrations

> **Blueprint only** — this directory contains architecture sketches, directory
> layouts, and configuration file shapes. It does NOT contain runnable code.
> Runnable example repositories are a separate deliverable (not shipped as of
> 2026-04-21). Use these blueprints to scaffold an integration; do not expect
> `npm install` + `npm run` to work from here.

This directory is the canonical reference layout for host integrations. The files here are intentionally code-light: they show folder shapes, config placement, and minimal entry-point snippets. Real runnable adapters should live in separate repositories or packages.

Each example follows the **thin host, thick Vega** contract:

- **Host responsibility** — build a transport envelope, validate it, then store / retrieve / use.
- **Vega responsibility** — own memory intelligence: embeddings, promotion, retrieval ranking, and semantic analysis.

The examples use `createEnvelopeBuilder` and `validateTransportEnvelope` from the SDK to keep host code focused on transport-level concerns only.

- [Claude Code example](./claude-code-example/README.md)
- [Cursor example](./cursor-example/README.md)
- [OpenCode example](./opencode-example/README.md)
