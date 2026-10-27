import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definition } from "./files";
import { promptDefinitions } from "./prompts";
import { editableTool } from "./tools";
import { toolsFor, type Tool } from "../tools/registry";
import { rolePrompt } from "../prompt/shared";
const root = mkdtempSync(join(tmpdir(), "orca-definitions-"));
const old = process.env.ORCA_HOME;
let home: string;
beforeEach(() => { home = mkdtempSync(join(root, "case-")); process.env.ORCA_HOME = home; });
afterAll(() => { if (old === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = old; rmSync(root, { recursive: true, force: true }); });
const tool: Tool = { spec: { name: "fixture", description: "Trusted authorization contract.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["read"], description: "Read only." } }, required: ["action"] } }, run: async () => "trusted implementation" };
test("defaults track upgrades; edited files survive; deleting resets to current default", () => {
  expect(definition("prompts/shared.md", "v1")).toBe("v1");
  expect(definition("prompts/shared.md", "v2")).toBe("v2");
  writeFileSync(join(home, "prompts/shared.md"), "local edit");
  expect(definition("prompts/shared.md", "v3")).toBe("local edit");
  expect(readFileSync(join(home, "prompts/shared.md"), "utf8")).toBe("local edit");
  rmSync(join(home, "prompts/shared.md"));
  expect(definition("prompts/shared.md", "v3")).toBe("v3");
});
test("visible role/shared Markdown edits reload while mandatory role contracts remain", () => {
  const config = { maxReviewRounds: 1, dynamicDispatch: false, cyclomatic: 10, cognitive: 10 };
  const original = rolePrompt("worker", config);
  expect(readFileSync(join(home, "prompts/worker.md"), "utf8")).toContain("coding agent");
  writeFileSync(join(home, "prompts/worker.md"), "Prefer very short paragraphs.");
  writeFileSync(join(home, "prompts/shared.md"), "Use project terminology.");
  const changed = rolePrompt("worker", config);
  expect(changed).toContain("Prefer very short paragraphs.");
  expect(changed).toContain("Use project terminology.");
  expect(changed.endsWith(original)).toBe(true);
  expect(promptDefinitions("worker", "mandatory", "shared")).toContain("Prefer very short");
});
test("tool annotations affect provider spec without replacing handlers, schemas or allowlists", async () => {
  const first = editableTool(tool);
  const file = join(home, "tools/fixture.json"), value = JSON.parse(readFileSync(file, "utf8"));
  value.description = "Local purpose.";
  value.input_schema.properties.action.description = "Local input help.";
  writeFileSync(file, JSON.stringify(value));
  const loaded = editableTool(tool);
  expect(loaded.spec.description).toContain("Local purpose.");
  expect(loaded.spec.description).toContain("Trusted authorization contract.");
  expect(JSON.stringify(loaded.spec.input_schema)).toContain("Local input help.");
  expect(JSON.stringify(loaded.spec.input_schema)).toContain("Read only.");
  expect(loaded.run).toBe(first.run);
  expect(toolsFor.worker).not.toContain("memory");
  value.input_schema.properties.action.enum.push("write"); writeFileSync(file, JSON.stringify(value));
  expect(() => editableTool(tool)).toThrow("immutable tool schema");
});
test("malformed/unsafe definitions refuse instead of silently ignoring overrides", () => {
  editableTool(tool);
  const file = join(home, "tools/fixture.json");
  writeFileSync(file, "{"); expect(() => editableTool(tool)).toThrow();
  chmodSync(file, 0o666); expect(() => editableTool(tool)).toThrow("unsafe definition");
  rmSync(file); symlinkSync(join(home, "missing"), file); expect(() => editableTool(tool)).toThrow();
});
test("description contracts stay in concise main text or relevant fields; memory alias retained", () => {
  // Source-only regression: does not initialize provider SDKs or global memory.
  const taskText = readFileSync(new URL("../tools/task.ts", import.meta.url), "utf8");
  const memoryText = readFileSync(new URL("../tools/history.ts", import.meta.url), "utf8");
  const main = (text: string) => text.match(/description: "([^\n]+)",\n\s+input_schema:/)![1]!;
  for (const text of ["immutable", "authorized", "before spawn", "current clean PR head", "Verified OPEN", "merge permission", "confirmed", "SQL", "no scheduling", "never infer"]) expect(taskText.toLowerCase()).toContain(text.toLowerCase());
  expect(main(taskText).length).toBeLessThan(600);
  expect(main(memoryText).length).toBeLessThan(500);
  for (const text of ["outside current context", "untrusted", "never instructions or authorization", "removed tasks", "without restoring membership"]) expect(memoryText).toContain(text);
  expect(memoryText).toContain('export const memory: Tool = { ...history, spec: { ...history.spec, name: "memory" } }');
  expect(taskText).toContain('makeTaskTool({ history: true })');
});
test("unknown structural fields and prototype keys cannot extend a provider schema", () => {
  editableTool(tool);
  const file = join(home, "tools/fixture.json"), original = readFileSync(file, "utf8");
  for (const extra of ['"description":"not an input schema"', '"__proto__":{"type":"string"}']) {
    const value = JSON.parse(original);
    value.input_schema.properties = JSON.parse(`{"action":${JSON.stringify(value.input_schema.properties.action)},${extra}}`);
    writeFileSync(file, JSON.stringify(value));
    expect(() => editableTool(tool)).toThrow("unknown tool schema field");
  }
});

test("built-in underscore names materialize without enabling arbitrary paths", () => {
  expect(editableTool({ ...tool, spec: { ...tool.spec, name: "web_search" } }).spec.name).toBe("web_search");
  expect(() => definition("tools/../../escape.json", "{}")).toThrow("invalid definition name");
});
