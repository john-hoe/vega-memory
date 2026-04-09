#!/usr/bin/env node

const printError = (message) => {
  console.error(message);
  process.exitCode = 1;
};

try {
  const [{ loadConfig }, tokenReportModule] = await Promise.all([
    import("../dist/config.js"),
    import("../dist/adapter/token-report.js")
  ]);
  const json = process.argv.includes("--json");
  const report = await tokenReportModule.createAdapterTokenReport(loadConfig());

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(tokenReportModule.buildAdapterTokenReportMarkdown(report));
  }
} catch (error) {
  if (error instanceof Error && /Cannot find module/u.test(error.message)) {
    printError("Build the project first with `npm run build`.");
  } else if (error instanceof Error) {
    printError(error.message);
  } else {
    printError(String(error));
  }
}
