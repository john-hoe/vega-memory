import type { SourceAdapter } from "./types.js";

export function createHostMemoryFileSource(): SourceAdapter {
  return {
    kind: "host_memory_file",
    name: "host-memory-file (pending Wave 5 adapter)",
    enabled: false,
    search() {
      return [];
    }
  };
}
