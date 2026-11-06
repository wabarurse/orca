import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definition } from "./files";
import { promptDefinitions } from "./prompts";
import { editableTool } from "./tools";
import { toolsFor, type Tool } from "../tools/registry";
import { rolePrompt } from "../prompt/shared";
import { message } from "../tools/message";
import { ask } from "../tools/ask";
import { runtime } from "../tools/runtime";
import { skill } from "../tools/skill";
import { processTool } from "../tools/process";
import { read } from "../tools/files";
const root = mkdtempSync(join(tmpdir(), "orca-definitions-"));
const old = process.env.ORCA_HOME;
let home: string;
beforeEach(() => { home = mkdtempSync(join(root, "case-")); process.env.ORCA_HOME = home; });
afterAll(() => { if (old === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = old; rmSync(root, { recursive: true, force: true }); });
const tool: Tool = { spec: { name: "fixture", description: "Trusted authorization contract.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["read"], description: "Read only." } }, required: ["action"] } }, run: async () => "trusted implementation" };
test("edited legacy read and process definitions gain batching and PR watches", () => {
  editableTool(read);
  const readFile = join(home, "tools/read.json");
  const oldRead = JSON.parse(readFileSync(readFile, "utf8"));
  oldRead.input_schema.required = ["path"];
  delete oldRead.input_schema.properties.files;
  oldRead.description = "Prefer exact file ranges.";
  writeFileSync(readFile, JSON.stringify(oldRead));
  const loadedRead = editableTool(read);
  expect(loadedRead.spec.description).toContain("Prefer exact file ranges.");
  expect(loadedRead.spec.input_schema.required).toBeUndefined();
  expect(loadedRead.spec.input_schema.properties).toHaveProperty("files");

  editableTool(processTool);
  const processFile = join(home, "tools/process.json");
  const oldProcess = JSON.parse(readFileSync(processFile, "utf8"));
  oldProcess.input_schema.properties.action.enum.pop();
  delete oldProcess.input_schema.properties.number;
  delete oldProcess.input_schema.properties.head;
  writeFileSync(processFile, JSON.stringify(oldProcess));
  expect(editableTool(processTool).spec.input_schema).toEqual(processTool.spec.input_schema);
});
test("edited legacy skill definitions gain search while retaining annotations", () => {
  editableTool(skill);
  const file = join(home, "tools/skill.json");
  const edited = JSON.parse(readFileSync(file, "utf8"));
  delete edited.input_schema.properties.search;
  edited.description = "Local skill guidance";
  writeFileSync(file, JSON.stringify(edited));
  const loaded = editableTool(skill);
  expect(loaded.spec.description).toContain("Local skill guidance");
  expect(loaded.spec.input_schema.properties).toHaveProperty("search");
});
test("edited legacy runtime definitions gain peer discovery while retaining annotations", () => {
  editableTool(runtime);
  const file = join(home, "tools/runtime.json"), edited = JSON.parse(readFileSync(file, "utf8"));
  edited.input_schema.properties.action.enum = ["status", "usage"];
  edited.description = "My runtime notes";
  writeFileSync(file, JSON.stringify(edited)); const original = readFileSync(file, "utf8");
  const loaded = editableTool(runtime);
  expect(loaded.spec.description).toContain("My runtime notes");
  expect(loaded.spec.input_schema.properties).toMatchObject({ action: { enum: ["status", "usage", "conversations"] } });
  expect(readFileSync(file, "utf8")).toBe(original);
  edited.input_schema.properties.action.enum = ["status", "usage", "arbitrary"];
  writeFileSync(file, JSON.stringify(edited));
  expect(() => editableTool(runtime)).toThrow("immutable tool schema");
});
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
  const original = rolePrompt("worker");
  expect(readFileSync(join(home, "prompts/worker.md"), "utf8")).toContain("focused agent");
  writeFileSync(join(home, "prompts/worker.md"), "Prefer very short paragraphs.");
  writeFileSync(join(home, "prompts/shared.md"), "Use project terminology.");
  const changed = rolePrompt("worker");
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
  for (const text of ["immutable", "authorized", "exact PR head", "confirmed", "history retained", "no scheduling", "never infer"]) expect(taskText.toLowerCase()).toContain(text.toLowerCase());
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

test('edited task schemas retire publication actions without losing annotations or rewriting user files', () => {
  const legacy: Tool = { ...tool, spec: { name: 'task', description: 'Task contract', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['get', 'checkpoint', 'prepare_publication', 'checks', 'reviewed', 'publish'], description: 'Action' }, commands: { type: 'array', items: { type: 'string' } } }, required: ['action'] } } };
  editableTool(legacy);
  const file = join(home, 'tools/task.json');
  const edited = JSON.parse(readFileSync(file, 'utf8')); edited.description = 'My task guidance';
  writeFileSync(file, JSON.stringify(edited)); const original = readFileSync(file, 'utf8');
  const current: Tool = { ...legacy, spec: { ...legacy.spec, input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['get'], description: 'Action' } }, required: ['action'] } } };
  const result = editableTool(current);
  expect(result.spec.description).toContain('My task guidance');
  expect(JSON.stringify(result.spec.input_schema)).not.toContain('prepare_publication');
  expect(JSON.stringify(result.spec.input_schema)).not.toContain('commands');
  expect(readFileSync(file, 'utf8')).toBe(original);
});

test("edited legacy message definitions gain the report bound without losing annotations", () => {
  editableTool(message);
  const file = join(home, "tools/message.json");
  const edited = JSON.parse(readFileSync(file, "utf8"));
  delete edited.input_schema.properties.summary.minLength;
  delete edited.input_schema.properties.summary.maxLength;
  edited.description = "Use concise project terminology.";
  edited.input_schema.properties.summary.description = "Include a reproducible example.";
  const source = JSON.stringify(edited);
  writeFileSync(file, source);

  const loaded = editableTool(message);
  expect(loaded.spec.description).toContain("Use concise project terminology.");
  expect(loaded.spec.input_schema.properties).toMatchObject({ summary: { minLength: 1, maxLength: 2000 } });
  expect(JSON.stringify(loaded.spec.input_schema)).toContain("Include a reproducible example.");
  expect(readFileSync(file, "utf8")).toBe(source);
  edited.input_schema.properties.summary.maxLength = 9000;
  writeFileSync(file, JSON.stringify(edited));
  expect(() => editableTool(message)).toThrow("immutable tool schema");
});

test("an edited legacy ask definition gains list/close without losing annotations", () => {
  const legacy: Tool = { ...ask, spec: { name: "ask", description: "Ask contract", input_schema: { type: "object", properties: { questions: { type: "array", description: "At most 10.", items: { type: "object" } } }, required: ["questions"] } } };
  editableTool(legacy);
  const file = join(home, "tools/ask.json");
  const edited = JSON.parse(readFileSync(file, "utf8")); edited.description = "My ask guidance";
  writeFileSync(file, JSON.stringify(edited));
  const upgraded: Tool = { ...legacy, spec: { ...legacy.spec, input_schema: { type: "object", properties: {
    action: { type: "string", enum: ["ask", "list", "close"] }, questions: { type: "array", description: "At most 10.", items: { type: "object" } },
    ids: { type: "array", items: { type: "string" } }, reason: { type: "string" },
  }, required: [] } } };
  const loaded = editableTool(upgraded);
  expect(loaded.spec.description).toContain("My ask guidance");
  expect(loaded.spec.input_schema.required).toEqual([]);
  expect(Object.keys(loaded.spec.input_schema.properties as object)).toEqual(["action", "questions", "ids", "reason"]);
});
