export function readFeatureFlag(name: string): boolean {
  const value = process.env[name];

  if (value === undefined) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "on" || normalized === "true" || normalized === "1";
}
