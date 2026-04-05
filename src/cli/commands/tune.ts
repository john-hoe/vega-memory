import { Command } from "commander";

import { RelevanceTuner } from "../../search/tuning.js";

export function registerTuneCommand(program: Command, relevanceTuner: RelevanceTuner): void {
  program
    .command("tune")
    .description("Analyze recall quality and suggest search tuning changes")
    .option("--json", "print JSON")
    .action((options: { json?: boolean }) => {
      const analysis = relevanceTuner.analyzeSearchQuality();
      const suggestions = relevanceTuner.suggestWeightAdjustments();

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              analysis,
              suggestions
            },
            null,
            2
          )
        );
        return;
      }

      console.log(`avg_latency_ms: ${analysis.avg_latency_ms}`);
      console.log(`avg_results: ${analysis.avg_results}`);
      console.log(`zero_result_pct: ${analysis.zero_result_pct}`);
      console.log(`type_distribution: ${JSON.stringify(analysis.type_distribution)}`);
      console.log(`suggested_vector_weight: ${suggestions.vectorWeight}`);
      console.log(`suggested_bm25_weight: ${suggestions.bm25Weight}`);
      console.log(`suggested_similarity_threshold: ${suggestions.similarityThreshold}`);

      for (const recommendation of analysis.recommendations) {
        console.log(`recommendation: ${recommendation}`);
      }
    });
}
