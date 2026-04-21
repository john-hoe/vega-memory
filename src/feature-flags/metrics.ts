export interface FlagHitSnapshot {
  on_count: number;
  off_count: number;
  reasons: Record<string, number>;
}

export interface FlagHitMetricsCollector {
  record(flagId: string, variant: "on" | "off", reason: string): void;
  snapshot(): Record<string, FlagHitSnapshot>;
  reset(): void;
}

export function createFlagHitMetricsCollector(): FlagHitMetricsCollector {
  const data = new Map<string, { on: number; off: number; reasons: Map<string, number> }>();

  return {
    record(flagId: string, variant: "on" | "off", reason: string): void {
      let entry = data.get(flagId);
      if (entry === undefined) {
        entry = { on: 0, off: 0, reasons: new Map() };
        data.set(flagId, entry);
      }
      if (variant === "on") {
        entry.on += 1;
      } else {
        entry.off += 1;
      }
      entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
    },

    snapshot(): Record<string, FlagHitSnapshot> {
      const result: Record<string, FlagHitSnapshot> = {};
      for (const [flagId, entry] of data) {
        const reasons: Record<string, number> = {};
        for (const [reason, count] of entry.reasons) {
          reasons[reason] = count;
        }
        result[flagId] = {
          on_count: entry.on,
          off_count: entry.off,
          reasons
        };
      }
      return result;
    },

    reset(): void {
      data.clear();
    }
  };
}
