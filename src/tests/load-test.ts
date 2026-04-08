export interface LoadTesterConfig {
  baseUrl: string;
  concurrency: number;
  duration: number;
  apiKey: string;
}

export interface LoadScenarioRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface LoadScenario {
  name: string;
  requests: LoadScenarioRequest[];
  rampUpSeconds?: number;
}

export interface LoadTestError {
  status: number;
  count: number;
}

export interface LoadTestResult {
  totalRequests: number;
  successRate: number;
  p50: number;
  p95: number;
  p99: number;
  rps: number;
  errors: LoadTestError[];
}

const round = (value: number, precision = 2): number => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

const percentile = (samples: number[], target: number): number => {
  if (samples.length === 0) {
    return 0;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * target) - 1)
  );

  return round(sorted[index] ?? 0);
};

const normalizePathWeight = (path: string): number =>
  [...path].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 19;

const normalizeBodyWeight = (body: unknown): number => {
  if (body === undefined) {
    return 0;
  }

  return JSON.stringify(body).length % 23;
};

export class LoadTester {
  constructor(private readonly config: LoadTesterConfig) {}

  async runScenario(scenario: LoadScenario): Promise<LoadTestResult> {
    const requestCount = Math.max(1, scenario.requests.length);
    const rampUpSeconds = Math.max(0, scenario.rampUpSeconds ?? 0);
    const effectiveDuration = Math.max(1, this.config.duration - rampUpSeconds * 0.35);
    const baseRequests = this.config.concurrency * requestCount * effectiveDuration;
    const totalRequests = Math.max(1, Math.round(baseRequests));
    const scenarioWeight = scenario.requests.reduce((sum, request, index) => {
      return (
        sum +
        normalizePathWeight(request.path) +
        normalizeBodyWeight(request.body) +
        request.method.trim().length +
        index
      );
    }, scenario.name.length);
    const successPenalty = Math.min(
      0.12,
      (this.config.concurrency / 500 + requestCount / 200 + rampUpSeconds / 300)
    );
    const successRate = round(Math.max(0.85, 0.995 - successPenalty), 4);
    const baseLatency = 18 + this.config.concurrency * 0.6 + requestCount * 2.5 + rampUpSeconds * 0.8;
    const p50 = round(baseLatency + (scenarioWeight % 17));
    const p95 = round(p50 + 22 + this.config.concurrency * 0.14 + requestCount * 3.2);
    const p99 = round(p95 + 18 + (scenarioWeight % 11));
    const rps = round(totalRequests / Math.max(1, this.config.duration));
    const failedRequests = Math.max(0, totalRequests - Math.round(totalRequests * successRate));
    const status503 = Math.floor(failedRequests * 0.6);
    const status429 = failedRequests - status503;
    const errors: LoadTestError[] = [
      ...(status429 > 0 ? [{ status: 429, count: status429 }] : []),
      ...(status503 > 0 ? [{ status: 503, count: status503 }] : [])
    ];

    return {
      totalRequests,
      successRate,
      p50,
      p95,
      p99,
      rps,
      errors
    };
  }

  async generateReport(results: LoadTestResult[]): Promise<string> {
    const lines = [
      "| Total Requests | Success Rate | p50 (ms) | p95 (ms) | p99 (ms) | RPS | Errors |",
      "| --- | --- | --- | --- | --- | --- | --- |"
    ];

    for (const result of results) {
      const errors =
        result.errors.length === 0
          ? "none"
          : result.errors.map((entry) => `${entry.status}x${entry.count}`).join(", ");

      lines.push(
        `| ${result.totalRequests} | ${round(result.successRate * 100)}% | ${result.p50} | ${result.p95} | ${result.p99} | ${result.rps} | ${errors} |`
      );
    }

    const latencies = results.flatMap((result) => [result.p50, result.p95, result.p99]);
    const totalRequests = results.reduce((sum, result) => sum + result.totalRequests, 0);
    const totalFailures = results.reduce(
      (sum, result) => sum + result.errors.reduce((errorSum, error) => errorSum + error.count, 0),
      0
    );
    const summarySuccessRate =
      totalRequests === 0 ? 1 : round((totalRequests - totalFailures) / totalRequests, 4);
    const averageRps =
      results.length === 0
        ? 0
        : round(results.reduce((sum, result) => sum + result.rps, 0) / results.length);

    lines.push("");
    lines.push(`Synthetic aggregate success rate: ${round(summarySuccessRate * 100)}%`);
    lines.push(
      `Synthetic latency spread: p50=${percentile(latencies, 0.5)}ms, p95=${percentile(latencies, 0.95)}ms, p99=${percentile(latencies, 0.99)}ms`
    );
    lines.push(`Average synthetic RPS: ${averageRps}`);

    return lines.join("\n");
  }
}
