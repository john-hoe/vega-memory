import { resolve } from "node:path";

export const FEATURE_FLAG_SCHEMA_VERSION = "1.0";
export const DEFAULT_FEATURE_FLAG_REGISTRY_PATH = resolve(process.cwd(), "docs/feature-flags/flags.yaml");

export interface SurfaceHeaderRequest {
  get(name: string): string | undefined;
}

export const extractSurfaceFromHeader = (request: SurfaceHeaderRequest): string | undefined => {
  const surface = request.get("x-vega-surface")?.trim();
  return surface === undefined || surface.length === 0 ? undefined : surface;
};
