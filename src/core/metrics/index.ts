export type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricDefinition {
  name: string;
  kind: MetricKind;
  description: string;
  slo_target?: number;
}

export interface MetricSample {
  name: string;
  value: number;
  tags?: Record<string, string>;
  timestamp: string;
}

export interface MetricsExporter {
  emit(sample: MetricSample): void;
}

export const CORE_METRICS: Record<string, MetricDefinition> = {
  promotion_precision_at_5: {
    name: "promotion_precision_at_5",
    kind: "gauge",
    description: "Top-5 promoted results scored by human or classifier review."
  },
  bundle_density: {
    name: "bundle_density",
    kind: "gauge",
    description: "Ratio of effective memory content to total token usage."
  },
  sufficiency_fp_rate: {
    name: "sufficiency_fp_rate",
    kind: "gauge",
    description: "Rate of sufficient checkpoints later overturned by follow-up need."
  },
  checkpoint_acked_rate: {
    name: "checkpoint_acked_rate",
    kind: "gauge",
    description: "Rate of checkpoint acknowledgements returning to the system."
  },
  silent_drop_rate: {
    name: "silent_drop_rate",
    kind: "gauge",
    description: "Rate of checkpoints expiring without an acknowledgement."
  }
};

const createTimestamp = (): string => new Date().toISOString();

export class MetricsPipeline {
  readonly #counters = new Map<string, number>();
  readonly #exporters: MetricsExporter[];

  constructor(exporters: MetricsExporter[]) {
    this.#exporters = [...exporters];
  }

  counter(name: string, tags?: Record<string, string>): void {
    const nextValue = (this.#counters.get(name) ?? 0) + 1;
    this.#counters.set(name, nextValue);
    this.#emit({
      name,
      value: nextValue,
      tags,
      timestamp: createTimestamp()
    });
  }

  gauge(name: string, value: number, tags?: Record<string, string>): void {
    this.#emit({
      name,
      value,
      tags,
      timestamp: createTimestamp()
    });
  }

  histogram(name: string, value: number, tags?: Record<string, string>): void {
    this.#emit({
      name,
      value,
      tags,
      timestamp: createTimestamp()
    });
  }

  addExporter(exporter: MetricsExporter): void {
    this.#exporters.push(exporter);
  }

  #emit(sample: MetricSample): void {
    if (!(sample.name in CORE_METRICS)) {
      console.warn(`Unknown metric emitted: ${sample.name}`);
    }

    for (const exporter of this.#exporters) {
      exporter.emit(sample);
    }
  }
}

export class ConsoleMetricsExporter implements MetricsExporter {
  emit(sample: MetricSample): void {
    console.log(JSON.stringify(sample));
  }
}
