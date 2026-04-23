const HOST_MEMORY_FILE_READONLY_FILES = [
  "src/retrieval/sources/host-memory-file.ts",
  "src/retrieval/sources/host-memory-file-fts.ts",
  "src/retrieval/sources/host-memory-file-paths.ts",
  "src/retrieval/sources/host-memory-file-parser.ts"
];

const HOST_MEMORY_FILE_READONLY_MESSAGE =
  "Host memory files are read-only. Vega never writes to host memory paths (P8-030 invariant).";

const BANNED_HOST_MEMORY_WRITE_SPECIFIERS = [
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "copyFile",
  "copyFileSync",
  "createWriteStream",
  "ftruncate",
  "ftruncateSync",
  "link",
  "linkSync",
  "mkdir",
  "mkdirSync",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "utimes",
  "utimesSync",
  "write",
  "writeFile",
  "writeFileSync",
  "writeSync",
  "writev",
  "writevSync"
];

const BANNED_HOST_MEMORY_WRITE_CALL_PATTERN =
  /^(appendFile|appendFileSync|chmod|chmodSync|chown|chownSync|copyFile|copyFileSync|createWriteStream|ftruncate|ftruncateSync|link|linkSync|mkdir|mkdirSync|open|openSync|rename|renameSync|rm|rmSync|symlink|symlinkSync|truncate|truncateSync|unlink|unlinkSync|utimes|utimesSync|write|writeFile|writeFileSync|writeSync|writev|writevSync)$/;

const CONTRACT_IMPORT_GUARD_MESSAGE =
  "Contract definitions must be imported from src/core/contracts/* (P8-003.7).";

const CONTRACT_IMPORT_GUARD_NAMES = [
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
];

const CONTRACT_IMPORT_GUARD_NAME_PATTERN = `^(${CONTRACT_IMPORT_GUARD_NAMES.join("|")})$`;
const CANONICAL_CONTRACT_IMPORT_PATTERN = "(^|\\/)contracts(\\/|$)";

module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module"
  },
  overrides: [
    {
      files: ["src/**/*.ts"],
      excludedFiles: ["src/core/contracts/**/*.ts"],
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector:
              `ImportDeclaration:not([source.value=/${CANONICAL_CONTRACT_IMPORT_PATTERN}/]) ImportSpecifier[imported.name=/${CONTRACT_IMPORT_GUARD_NAME_PATTERN}/]`,
            message: CONTRACT_IMPORT_GUARD_MESSAGE
          },
          {
            selector:
              `ImportDeclaration:not([source.value=/${CANONICAL_CONTRACT_IMPORT_PATTERN}/]) ImportDefaultSpecifier[local.name=/${CONTRACT_IMPORT_GUARD_NAME_PATTERN}/]`,
            message: CONTRACT_IMPORT_GUARD_MESSAGE
          }
        ]
      }
    },
    {
      files: ["src/retrieval/sources/host-memory-file*.ts"],
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module"
      }
    },
    {
      files: HOST_MEMORY_FILE_READONLY_FILES,
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: ["node:fs", "fs", "node:fs/promises", "fs/promises"].map((name) => ({
              name,
              importNames: BANNED_HOST_MEMORY_WRITE_SPECIFIERS,
              message: HOST_MEMORY_FILE_READONLY_MESSAGE
            }))
          }
        ],
        "no-restricted-syntax": [
          "error",
          {
            selector:
              `CallExpression[callee.type='MemberExpression'][callee.property.name=/${BANNED_HOST_MEMORY_WRITE_CALL_PATTERN.source}/]`,
            message: HOST_MEMORY_FILE_READONLY_MESSAGE
          },
          {
            selector:
              `CallExpression[callee.type='Identifier'][callee.name=/${BANNED_HOST_MEMORY_WRITE_CALL_PATTERN.source}/]`,
            message: HOST_MEMORY_FILE_READONLY_MESSAGE
          }
        ]
      }
    }
  ]
};
