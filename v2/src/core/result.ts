import { z } from "zod";

export type Result<T, E = string> = { ok: true; data: T } | { ok: false; error: E };

export const ok = <T>(data: T): { ok: true; data: T } => ({ ok: true, data });
export const fail = <E = string>(error: E): { ok: false; error: E } => ({ ok: false, error });

export function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const AnyRecord = z.record(z.string(), z.unknown());
export function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = AnyRecord.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseJson(text: string): Result<unknown> {
  try { return ok(JSON.parse(text)); } catch (error) { return fail(errorMessage(error)); }
}
