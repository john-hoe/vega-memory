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

module.exports = {
  root: true,
  overrides: [
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
