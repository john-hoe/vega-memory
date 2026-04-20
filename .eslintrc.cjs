module.exports = {
  root: true,
  overrides: [
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
            selector:
              "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(writeFile|writeFileSync|appendFile|appendFileSync|write|rm|rmSync|unlink|unlinkSync|mkdir|mkdirSync|copyFile|copyFileSync|rename|renameSync|chmod|chmodSync|chown|chownSync|truncate|truncateSync|createWriteStream)$/]",
            message:
              "Host memory files are read-only. Vega never writes to host memory paths (P8-030 invariant)."
          }
        ]
      }
    }
  ]
};
