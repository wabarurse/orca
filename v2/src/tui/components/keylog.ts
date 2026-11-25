import { appendFileSync } from "node:fs";

export const KEYLOG_ENV = "ORCA2_KEYLOG";

export function keyLogPath(env: Record<string, string | undefined> = process.env): string | null {
  const path = env[KEYLOG_ENV];
  return path !== undefined && path.length > 0 ? path : null;
}

export function keyLog(line: string, path: string | null = keyLogPath()): void {
  if (path === null) return;
  try { appendFileSync(path, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch { return; }
}
