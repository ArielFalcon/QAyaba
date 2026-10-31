import { activeEnvironment } from "./active";

export function requireEnv(key: string): string {
  const v = activeEnvironment()[key];
  if (!v) throw new Error(`Missing environment variable: ${key}`);
  return v;
}
