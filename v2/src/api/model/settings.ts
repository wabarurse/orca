import { z } from "zod";
import { fail, ok, type Result } from "../result";
import { knownEfforts, modelCapabilities, type Effort } from "./capabilities";

export type RequestSettings = { effort?: Effort; fast?: boolean };

const record = z.record(z.string(), z.unknown());

export function parseSettings(value: unknown): Result<{ effort?: string; fast?: boolean }> {
  const entry = record.safeParse(value);
  if (!entry.success || Array.isArray(value)) return fail("invalid project model settings: expected a record");
  const unexpected = Object.keys(entry.data).filter((key) => key !== "effort" && key !== "fast");
  if (unexpected.length > 0) return fail(`invalid project model settings: unexpected keys: ${unexpected.join(", ")}`);
  const { effort, fast } = entry.data;
  if (effort !== undefined && typeof effort !== "string") return fail("invalid effort: expected a string");
  if (fast !== undefined && typeof fast !== "boolean") return fail("invalid fast mode: expected a boolean");
  return ok({ ...(effort !== undefined ? { effort } : {}), ...(fast !== undefined ? { fast } : {}) });
}

export function validateSettings(model: string, settings: RequestSettings, efforts: Effort[] = knownEfforts(model)): Result<RequestSettings> {
  const shape = parseSettings(settings);
  if (!shape.ok) return shape;
  const supported = modelCapabilities(model);
  const effort = efforts.find(level => level === shape.data.effort);
  if (shape.data.effort !== undefined && effort === undefined) {
    const offered = supported.effort.length > 0 ? supported.effort.join(", ") : "no explicit levels";
    return fail(`effort ${shape.data.effort} is unsupported for ${model}; supported: default, ${offered}`);
  }
  if (shape.data.fast === true && !supported.fast) return fail(`fast mode is unsupported for ${model} on this endpoint`);
  return ok({ ...(effort !== undefined ? { effort } : {}), ...(shape.data.fast !== undefined ? { fast: shape.data.fast } : {}) });
}
