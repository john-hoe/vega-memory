import type { AckStore } from "./ack-store.js";
import type { CheckpointFailureStore } from "./checkpoint-failure-store.js";
import type { CheckpointStore } from "./checkpoint-store.js";

export type Phase8PersistenceStatus = "enabled" | "disabled-postgres";

export interface Phase8Status {
  backend: "sqlite" | "postgres";
  persistence: {
    checkpoint_store: Phase8PersistenceStatus;
    ack_store: Phase8PersistenceStatus;
    checkpoint_failure_store: Phase8PersistenceStatus;
  };
  phase8_ready: boolean;
}

function resolveStoreStatus(
  store: AckStore | CheckpointFailureStore | CheckpointStore | undefined
): Phase8PersistenceStatus {
  return store !== undefined ? "enabled" : "disabled-postgres";
}

export function buildPhase8Status(input: {
  isPostgres: boolean;
  checkpointStore: CheckpointStore | undefined;
  ackStore: AckStore | undefined;
  checkpointFailureStore: CheckpointFailureStore | undefined;
}): Phase8Status {
  const persistence = {
    checkpoint_store: resolveStoreStatus(input.checkpointStore),
    ack_store: resolveStoreStatus(input.ackStore),
    checkpoint_failure_store: resolveStoreStatus(input.checkpointFailureStore)
  };

  return {
    backend: input.isPostgres ? "postgres" : "sqlite",
    persistence,
    phase8_ready: Object.values(persistence).every((status) => status === "enabled")
  };
}
