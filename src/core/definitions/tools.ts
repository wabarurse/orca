import type { Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
interface Tool { spec: ApiTool }
import { definition } from "./files";

// Input structure and validation remain trusted. Annotation edits are effective
// provider schema edits, not executable extensions or new input capabilities.
function annotations(base: unknown, edited: unknown, path: string): unknown {
  const added = ["spawn.properties.fresh", "bash.properties.background", "bash.properties.yield_ms", "bash.properties.ready_url", "message.properties.summary", "ask.properties.action", "ask.properties.ids", "ask.properties.reason"];
  if (edited === undefined && added.includes(path)) return base;
  if (path === "spawn.required" && JSON.stringify(edited) === '["prompt","branch","taskId"]') return base;
  if (path === "ask.required" && JSON.stringify(edited) === '["questions"]') return base; // list/close take no questions
  if (path === "bash.properties.timeout_ms.minimum" && edited === 1 && base === 0) return base;
  // Upgrade older edited schemas without overwriting user annotation files. Only
  // these shipped additions are restored; arbitrary schema mutations still fail.
  if (edited === undefined && ["spawn.properties.baseCommit", "task.properties.commands", "memory.properties.commands", "message.properties.summary.minLength", "message.properties.summary.maxLength"].includes(path)) return base;
  if (Array.isArray(base) && Array.isArray(edited) && path.endsWith(".properties.action.enum")) {
    const additions = new Set(["checkpoint", "prepare_publication", "checks", "reviewed", "publish"]);
    if (JSON.stringify(edited) === JSON.stringify(base.filter(v => !additions.has(String(v))))) return base;
  }
  if (Array.isArray(base)) {
    if (!Array.isArray(edited) || edited.length !== base.length) throw new Error(`immutable tool schema: ${path}`);
    return base.map((v, i) => annotations(v, edited[i], `${path}.${i}`));
  }
  if (base && typeof base === "object") {
    return objectAnnotations(base as Record<string, unknown>, edited, path);
  }
  if (base !== edited) throw new Error(`immutable tool schema: ${path}`);
  return base;
}
function description(base: unknown, edited: unknown, path: string) {
  if (edited === undefined) return base; // Newly shipped guidance on an existing field.
  if (typeof edited !== "string" || !edited.trim()) throw new Error(`invalid description: ${path}`);
  // Essential shipped field guidance cannot be erased by an override.
  return edited === base ? base : `${edited}\n${base ?? ""}`;
}
function objectAnnotations(a: Record<string, unknown>, edited: unknown, path: string) {
  if (!edited || typeof edited !== "object" || Array.isArray(edited)) throw new Error(`invalid tool schema: ${path}`);
  const b = edited as Record<string, unknown>, schemaNode = !path.endsWith(".properties");
  if (Object.keys(b).some(k => !Object.hasOwn(a, k) && !(k === "description" && schemaNode))) throw new Error(`unknown tool schema field: ${path}`);
  const result: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    result[key] = key === "description" && schemaNode
      ? description(a[key], b[key], path)
      : annotations(a[key], b[key], `${path}.${key}`);
  }
  return result;
}
export function editableTool<T extends Tool>(tool: T, variant = tool.spec.name): T {
  const defaults = { description: tool.spec.description, input_schema: tool.spec.input_schema };
  const raw = definition(`tools/${variant}.json`, JSON.stringify(defaults, null, 2) + "\n");
  const value = JSON.parse(raw);
  if (!value || Object.keys(value).sort().join() !== "description,input_schema" || typeof value.description !== "string" || !value.description.trim()) throw new Error(`invalid tool definition: ${tool.spec.name}`);
  const schema = annotations(defaults.input_schema, value.input_schema, tool.spec.name) as Tool["spec"]["input_schema"];
  return { ...tool, spec: { ...tool.spec, input_schema: schema, description: value.description === defaults.description ? defaults.description : `${value.description}\nMandatory tool contract: ${defaults.description}` } };
}
