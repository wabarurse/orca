import type { Tool } from "../tools/registry";
import { definition } from "./files";

// Input structure and validation remain trusted. Annotation edits are effective
// provider schema edits, not executable extensions or new input capabilities.
function annotations(base: unknown, edited: unknown, path: string): unknown {
  if (Array.isArray(base)) {
    if (!Array.isArray(edited) || edited.length !== base.length) throw new Error(`immutable tool schema: ${path}`);
    return base.map((v, i) => annotations(v, edited[i], `${path}.${i}`));
  }
  if (base && typeof base === "object") {
    if (!edited || typeof edited !== "object" || Array.isArray(edited)) throw new Error(`invalid tool schema: ${path}`);
    const a = base as Record<string, unknown>, b = edited as Record<string, unknown>;
    const schemaNode = !path.endsWith(".properties");
    if (Object.keys(b).some(k => !Object.hasOwn(a, k) && !(k === "description" && schemaNode))) throw new Error(`unknown tool schema field: ${path}`);
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key === "description" && schemaNode) {
        if (typeof b[key] !== "string" || !(b[key] as string).trim()) throw new Error(`invalid description: ${path}`);
        // Essential shipped field guidance cannot be erased by an override.
        result[key] = b[key] === a[key] ? a[key] : `${b[key]}\n${a[key] ?? ""}`;
      } else result[key] = annotations(a[key], b[key], `${path}.${key}`);
    }
    return result;
  }
  if (base !== edited) throw new Error(`immutable tool schema: ${path}`);
  return base;
}
export function editableTool(tool: Tool, variant = tool.spec.name): Tool {
  const defaults = { description: tool.spec.description, input_schema: tool.spec.input_schema };
  const raw = definition(`tools/${variant}.json`, JSON.stringify(defaults, null, 2) + "\n");
  const value = JSON.parse(raw);
  if (!value || Object.keys(value).sort().join() !== "description,input_schema" || typeof value.description !== "string" || !value.description.trim()) throw new Error(`invalid tool definition: ${tool.spec.name}`);
  const schema = annotations(defaults.input_schema, value.input_schema, tool.spec.name) as Tool["spec"]["input_schema"];
  return { ...tool, spec: { ...tool.spec, input_schema: schema, description: value.description === defaults.description ? defaults.description : `${value.description}\nMandatory tool contract: ${defaults.description}` } };
}
