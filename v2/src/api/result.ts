export type Result<T, E = string> = { ok: true; data: T } | { ok: false; error: E };

export const ok = <T>(data: T): { ok: true; data: T } => ({ ok: true, data });
export const fail = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });
