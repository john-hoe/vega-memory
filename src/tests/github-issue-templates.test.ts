import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const projectRoot = process.cwd();
const isMarkdownFile = (entry: string | Buffer): entry is string =>
  typeof entry === "string" && entry.endsWith(".md");

test("issue template labels do not contain unsubstituted placeholders", () => {
  const issueTemplateDirectory = join(projectRoot, ".github", "ISSUE_TEMPLATE");
  const templateFiles = readdirSync(issueTemplateDirectory).filter((entry) => entry.endsWith(".yml"));

  for (const templateFile of templateFiles) {
    const templatePath = join(issueTemplateDirectory, templateFile);
    const content = readFileSync(templatePath, "utf8");
    const labelBlocks = [...content.matchAll(/^labels:\s*\n((?:^\s+- .*\n?)+)/gmu)];

    for (const [, labelBlock] of labelBlocks) {
      assert.doesNotMatch(
        labelBlock,
        /<(?:N|stage)>/iu,
        `${templateFile} contains an unsubstituted placeholder in labels`
      );
    }
  }
});

test("host integration docs and examples do not use repo-relative SDK imports", () => {
  const documentationRoots = [
    join(projectRoot, "docs", "guides", "host-integration"),
    join(projectRoot, "docs", "examples")
  ];
  const markdownFiles = documentationRoots.flatMap((root) =>
    readdirSync(root, { recursive: true })
      .filter(isMarkdownFile)
      .map((entry) => join(root, entry))
  );

  for (const markdownFile of markdownFiles) {
    const content = readFileSync(markdownFile, "utf8");

    assert.doesNotMatch(
      content,
      /from\s+"(?:\.\.\/)+src\/sdk\/index\.js"/u,
      `${markdownFile} still imports VegaClient from a repo-relative SDK path`
    );
  }
});
