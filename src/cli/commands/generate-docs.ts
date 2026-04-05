import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Command, Option } from "commander";

import { DocGenerator } from "../../core/doc-generator.js";

type DocType = "readme" | "decisions" | "pitfalls" | "all";

const DOC_FILES: Record<Exclude<DocType, "all">, string> = {
  readme: "README.md",
  decisions: "DECISIONS.md",
  pitfalls: "PITFALLS.md"
};

const buildDocs = (docGenerator: DocGenerator, project: string): Record<Exclude<DocType, "all">, string> => ({
  readme: docGenerator.generateProjectReadme(project),
  decisions: docGenerator.generateDecisionLog(project),
  pitfalls: docGenerator.generatePitfallGuide(project)
});

export function registerDocGeneratorCommand(
  program: Command,
  docGenerator: DocGenerator
): void {
  program
    .command("generate-docs")
    .description("Generate project documentation from stored memories")
    .requiredOption("--project <project>", "project name")
    .option("--output <dir>", "output directory")
    .option("--json", "print JSON")
    .addOption(
      new Option("--type <type>", "document type")
        .choices(["readme", "decisions", "pitfalls", "all"])
        .default("all")
    )
    .action((options: { project: string; output?: string; type: DocType; json?: boolean }) => {
      const docs = buildDocs(docGenerator, options.project);
      const selected =
        options.type === "all"
          ? (Object.keys(docs) as Array<Exclude<DocType, "all">>)
          : [options.type];

      if (options.output) {
        const outputDir = resolve(options.output);
        const written: Record<string, string> = {};
        mkdirSync(outputDir, { recursive: true });

        for (const docType of selected) {
          const outputPath = join(outputDir, DOC_FILES[docType]);
          writeFileSync(outputPath, `${docs[docType]}\n`, "utf8");
          written[docType] = outputPath;
        }

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                project: options.project,
                written
              },
              null,
              2
            )
          );
          return;
        }

        for (const outputPath of Object.values(written)) {
          console.log(outputPath);
        }

        return;
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            Object.fromEntries(selected.map((docType) => [docType, docs[docType]])),
            null,
            2
          )
        );
        return;
      }

      if (selected.length === 1) {
        console.log(docs[selected[0]]);
        return;
      }

      console.log(
        selected
          .map((docType) => `<!-- ${DOC_FILES[docType]} -->\n\n${docs[docType]}`)
          .join("\n\n")
      );
    });
}
