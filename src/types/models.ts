export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A model's context size. `estimated` when it is the fallback, not a known size. */
export interface ContextWindow { limit: number; estimated: boolean }
