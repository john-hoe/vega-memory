type MetricLabels = Record<string, string>;

export interface CounterMetric {
  inc(labels?: MetricLabels, value?: number): void;
}

export interface HistogramMetric {
  observe(value: number, labels?: MetricLabels): void;
}

export interface GaugeMetric {
  set(value: number, labels?: MetricLabels): void;
  inc(labels?: MetricLabels, value?: number): void;
  dec(labels?: MetricLabels, value?: number): void;
  reset(labels?: MetricLabels): void;
}

interface MetricsCollectorConfig {
  enabled: boolean;
  port?: number;
  prefix?: string;
}

interface MetricDefinitionBase {
  type: "counter" | "histogram" | "gauge";
  name: string;
  help: string;
  labels: string[];
}

interface CounterState {
  labels: MetricLabels;
  value: number;
}

interface GaugeState {
  labels: MetricLabels;
  value: number;
}

interface HistogramState {
  labels: MetricLabels;
  count: number;
  sum: number;
  bucketCounts: number[];
}

interface CounterDefinition extends MetricDefinitionBase {
  type: "counter";
  values: Map<string, CounterState>;
}

interface GaugeDefinition extends MetricDefinitionBase {
  type: "gauge";
  values: Map<string, GaugeState>;
}

interface HistogramDefinition extends MetricDefinitionBase {
  type: "histogram";
  buckets: number[];
  values: Map<string, HistogramState>;
}

type MetricDefinition = CounterDefinition | GaugeDefinition | HistogramDefinition;

const sanitizeMetricName = (value: string): string => value.replace(/[^a-zA-Z0-9_:]/g, "_");

const escapeLabelValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

const cloneLabels = (labels: MetricLabels): MetricLabels => ({ ...labels });

const normalizeLabels = (labelNames: string[], labels?: MetricLabels): MetricLabels =>
  Object.fromEntries(labelNames.map((name) => [name, labels?.[name] ?? ""])) as MetricLabels;

const labelSignature = (labelNames: string[], labels: MetricLabels): string =>
  JSON.stringify(labelNames.map((name) => [name, labels[name] ?? ""]));

const renderMetricLine = (name: string, value: number, labels: MetricLabels): string => {
  const entries = Object.entries(labels);

  if (entries.length === 0) {
    return `${name} ${value}`;
  }

  const renderedLabels = entries
    .map(([key, labelValue]) => `${key}="${escapeLabelValue(labelValue)}"`)
    .join(",");

  return `${name}{${renderedLabels}} ${value}`;
};

const assertFiniteNumber = (value: number, field: string): void => {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
};

export class MetricsCollector {
  private readonly metrics = new Map<string, MetricDefinition>();
  private readonly gaugeCollectors = new Map<string, () => void | Promise<void>>();

  constructor(private readonly config: MetricsCollectorConfig) {}

  counter(name: string, help: string, labels: string[] = []): CounterMetric {
    const metricName = this.resolveMetricName(name);
    const definition = this.getOrCreateCounter(metricName, help, labels);

    return {
      inc: (seriesLabels?: MetricLabels, value = 1): void => {
        if (!this.config.enabled) {
          return;
        }

        assertFiniteNumber(value, "counter increment");
        const normalizedLabels = normalizeLabels(definition.labels, seriesLabels);
        const signature = labelSignature(definition.labels, normalizedLabels);
        const current = definition.values.get(signature);

        if (current) {
          current.value += value;
          return;
        }

        definition.values.set(signature, {
          labels: cloneLabels(normalizedLabels),
          value
        });
      }
    };
  }

  histogram(
    name: string,
    help: string,
    buckets: number[] = [0.1, 0.5, 1, 2.5, 5, 10],
    labels: string[] = []
  ): HistogramMetric {
    const metricName = this.resolveMetricName(name);
    const definition = this.getOrCreateHistogram(metricName, help, buckets, labels);

    return {
      observe: (value: number, seriesLabels?: MetricLabels): void => {
        if (!this.config.enabled) {
          return;
        }

        assertFiniteNumber(value, "histogram observation");
        const normalizedLabels = normalizeLabels(definition.labels, seriesLabels);
        const signature = labelSignature(definition.labels, normalizedLabels);
        const current =
          definition.values.get(signature) ??
          (() => {
            const created: HistogramState = {
              labels: cloneLabels(normalizedLabels),
              count: 0,
              sum: 0,
              bucketCounts: definition.buckets.map(() => 0)
            };
            definition.values.set(signature, created);
            return created;
          })();

        current.count += 1;
        current.sum += value;

        definition.buckets.forEach((bucket, index) => {
          if (value <= bucket) {
            current.bucketCounts[index] += 1;
          }
        });
      }
    };
  }

  gauge(name: string, help: string, labels: string[] = []): GaugeMetric {
    const metricName = this.resolveMetricName(name);
    const definition = this.getOrCreateGauge(metricName, help, labels);

    const getSeries = (seriesLabels?: MetricLabels): { signature: string; state: GaugeState } => {
      const normalizedLabels = normalizeLabels(definition.labels, seriesLabels);
      const signature = labelSignature(definition.labels, normalizedLabels);
      const current = definition.values.get(signature);

      if (current) {
        return {
          signature,
          state: current
        };
      }

      const created: GaugeState = {
        labels: cloneLabels(normalizedLabels),
        value: 0
      };
      definition.values.set(signature, created);
      return {
        signature,
        state: created
      };
    };

    return {
      set: (value: number, seriesLabels?: MetricLabels): void => {
        if (!this.config.enabled) {
          return;
        }

        assertFiniteNumber(value, "gauge value");
        getSeries(seriesLabels).state.value = value;
      },
      inc: (seriesLabels?: MetricLabels, value = 1): void => {
        if (!this.config.enabled) {
          return;
        }

        assertFiniteNumber(value, "gauge increment");
        getSeries(seriesLabels).state.value += value;
      },
      dec: (seriesLabels?: MetricLabels, value = 1): void => {
        if (!this.config.enabled) {
          return;
        }

        assertFiniteNumber(value, "gauge decrement");
        getSeries(seriesLabels).state.value -= value;
      },
      reset: (seriesLabels?: MetricLabels): void => {
        if (!this.config.enabled) {
          return;
        }

        if (seriesLabels === undefined) {
          definition.values.clear();
          return;
        }

        definition.values.delete(getSeries(seriesLabels).signature);
      }
    };
  }

  registerGaugeCollector(name: string, collect: () => void | Promise<void>): void {
    const metricName = this.resolveMetricName(name);
    const definition = this.metrics.get(metricName);

    if (definition === undefined || definition.type !== "gauge") {
      throw new Error(`Gauge metric ${metricName} must be registered before adding a collector`);
    }

    this.gaugeCollectors.set(metricName, collect);
  }

  async getMetrics(): Promise<string> {
    if (!this.config.enabled) {
      return "";
    }

    for (const collect of this.gaugeCollectors.values()) {
      await collect();
    }

    const sections = Array.from(this.metrics.values(), (definition) => this.renderMetric(definition))
      .filter((section) => section.length > 0);

    return sections.length === 0 ? "" : `${sections.join("\n\n")}\n`;
  }

  private resolveMetricName(name: string): string {
    const sanitizedName = sanitizeMetricName(name);
    const prefix = this.config.prefix?.trim();

    if (!prefix) {
      return sanitizedName;
    }

    return `${sanitizeMetricName(prefix)}_${sanitizedName}`;
  }

  private getOrCreateCounter(name: string, help: string, labels: string[]): CounterDefinition {
    return this.getOrCreateMetric(
      name,
      help,
      labels,
      "counter",
      () => ({
        type: "counter",
        name,
        help,
        labels: [...labels],
        values: new Map<string, CounterState>()
      })
    ) as CounterDefinition;
  }

  private getOrCreateHistogram(
    name: string,
    help: string,
    buckets: number[],
    labels: string[]
  ): HistogramDefinition {
    const normalizedBuckets = [...buckets].sort((left, right) => left - right);

    return this.getOrCreateMetric(
      name,
      help,
      labels,
      "histogram",
      () => ({
        type: "histogram",
        name,
        help,
        labels: [...labels],
        buckets: normalizedBuckets,
        values: new Map<string, HistogramState>()
      })
    ) as HistogramDefinition;
  }

  private getOrCreateGauge(name: string, help: string, labels: string[]): GaugeDefinition {
    return this.getOrCreateMetric(
      name,
      help,
      labels,
      "gauge",
      () => ({
        type: "gauge",
        name,
        help,
        labels: [...labels],
        values: new Map<string, GaugeState>()
      })
    ) as GaugeDefinition;
  }

  private getOrCreateMetric(
    name: string,
    help: string,
    labels: string[],
    type: MetricDefinition["type"],
    create: () => MetricDefinition
  ): MetricDefinition {
    const existing = this.metrics.get(name);

    if (!existing) {
      const created = create();
      this.metrics.set(name, created);
      return created;
    }

    const existingLabels = JSON.stringify(existing.labels);
    const requestedLabels = JSON.stringify(labels);

    if (existing.type !== type || existing.help !== help || existingLabels !== requestedLabels) {
      throw new Error(`Metric ${name} is already registered with a different definition`);
    }

    if (existing.type === "histogram") {
      const requested = create() as HistogramDefinition;

      if (JSON.stringify(existing.buckets) !== JSON.stringify(requested.buckets)) {
        throw new Error(`Metric ${name} is already registered with different buckets`);
      }
    }

    return existing;
  }

  private renderMetric(definition: MetricDefinition): string {
    const lines = [
      `# HELP ${definition.name} ${definition.help}`,
      `# TYPE ${definition.name} ${definition.type}`
    ];

    switch (definition.type) {
      case "counter":
      case "gauge": {
        Array.from(definition.values.values())
          .sort((left, right) =>
            labelSignature(definition.labels, left.labels).localeCompare(
              labelSignature(definition.labels, right.labels)
            )
          )
          .forEach((entry) => {
            lines.push(renderMetricLine(definition.name, entry.value, entry.labels));
          });
        break;
      }
      case "histogram": {
        Array.from(definition.values.values())
          .sort((left, right) =>
            labelSignature(definition.labels, left.labels).localeCompare(
              labelSignature(definition.labels, right.labels)
            )
          )
          .forEach((entry) => {
            definition.buckets.forEach((bucket, index) => {
              lines.push(
                renderMetricLine(`${definition.name}_bucket`, entry.bucketCounts[index], {
                  ...entry.labels,
                  le: String(bucket)
                })
              );
            });
            lines.push(
              renderMetricLine(`${definition.name}_bucket`, entry.count, {
                ...entry.labels,
                le: "+Inf"
              })
            );
            lines.push(renderMetricLine(`${definition.name}_sum`, entry.sum, entry.labels));
            lines.push(renderMetricLine(`${definition.name}_count`, entry.count, entry.labels));
          });
        break;
      }
    }

    return lines.join("\n");
  }
}
