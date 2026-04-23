import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const CONTRACT_IMPORT_NAMES = new Set([
  "SURFACES",
  "Surface",
  "ROLES",
  "Role",
  "EVENT_TYPES",
  "EventType",
  "SOURCE_KINDS",
  "SourceKind",
  "INTENTS",
  "Intent",
  "MODES",
  "Mode",
  "HOST_TIERS",
  "HostTier",
  "SUFFICIENCY",
  "Sufficiency",
  "RETRIEVAL_INTENTS",
  "RetrievalIntent",
  "HOST_EVENT_ENVELOPE_TRANSPORT_V1",
  "HOST_EVENT_ENVELOPE_V1",
  "HostEventEnvelopeTransportV1",
  "HostEventEnvelopeV1",
  "EnvelopeArtifact",
  "EnvelopeSafety",
  "BUNDLE_SCHEMA",
  "BUNDLE_SECTION_SCHEMA",
  "BUNDLE_RECORD_SCHEMA",
  "Bundle",
  "BundleInput",
  "BundleSection",
  "BundleRecord",
  "BundleRecordProvenance",
  "INTENT_REQUEST_SCHEMA",
  "IntentRequest",
  "CHECKPOINT_RECORD_SCHEMA",
  "CheckpointRecord",
  "USAGE_ACK_SCHEMA",
  "UsageAck",
  "USAGE_CHECKPOINT_SCHEMA",
  "UsageCheckpoint",
  "USAGE_FALLBACK_REQUEST_SCHEMA",
  "UsageFallbackRequest",
  "UsageFallbackResponse",
  "UsageFallbackDecision"
]);
const IMPORT_PATTERN = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/gmu;

function isCanonicalContractImport(source: string): boolean {
  return /(?:^|\/)contracts(?:\/|$)/u.test(source);
}

function collectTypeScriptFiles(root: string): string[] {
  const result: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectTypeScriptFiles(path));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      result.push(path);
    }
  }

  return result;
}

function importedName(specifier: string): string {
  return specifier.replace(/^type\s+/u, "").split(/\s+as\s+/iu)[0]?.trim() ?? "";
}

function collectContractImportViolations(source: string, filePath: string): string[] {
  if (filePath.startsWith("src/core/contracts/")) {
    return [];
  }

  const violations: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifiers = (match[1] ?? "")
      .split(",")
      .map((specifier) => specifier.trim())
      .filter((specifier) => specifier.length > 0);
    const importSource = match[2] ?? "";

    if (isCanonicalContractImport(importSource)) {
      continue;
    }

    for (const specifier of specifiers) {
      const name = importedName(specifier);
      if (CONTRACT_IMPORT_NAMES.has(name)) {
        violations.push(`${filePath}: import ${name} from ${importSource}`);
      }
    }
  }

  return violations;
}

test("contract import guard allows canonical core/contracts imports", () => {
  assert.deepEqual(
    collectContractImportViolations(
      `import type { Bundle } from "../core/contracts/bundle.js";`,
      "src/tests/example.test.ts"
    ),
    []
  );
});

test("contract import guard flags contract names imported from non-canonical modules", () => {
  const legacyImport = "import type { Bundle, IntentRequest as Request }" + ` from "../retrieval/types.js";`;

  assert.deepEqual(
    collectContractImportViolations(
      legacyImport,
      "src/retrieval/legacy.ts"
    ),
    [
      "src/retrieval/legacy.ts: import Bundle from ../retrieval/types.js",
      "src/retrieval/legacy.ts: import IntentRequest from ../retrieval/types.js"
    ]
  );
});

test("current source tree imports contract definitions only from core/contracts", () => {
  const violations = collectTypeScriptFiles("src").flatMap((filePath) =>
    collectContractImportViolations(readFileSync(filePath, "utf8"), filePath)
  );

  assert.deepEqual(violations, []);
});
