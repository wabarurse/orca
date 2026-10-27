import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry, toolsFor } from "../tools";
import { orchestratorTask } from "../tools/task";
import { toResponseTools } from "../../providers/openai";
import { editableTool } from "./tools";

const previous = process.env.ORCA_HOME;
const home = mkdtempSync(join(tmpdir(), "orca-provider-definitions-"));
process.env.ORCA_HOME = home;
afterAll(() => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

test("real mounted role tools load editable definitions into provider specs without new capabilities", () => {
  for (const role of ["worker", "reviewer", "orchestrator"] as const) {
    const loaded = toolsFor[role].map(name => {
      const original = role === "orchestrator" && name === "task" ? orchestratorTask : registry[name]!;
      const tool = editableTool(original, role === "orchestrator" && name === "task" ? "task-orchestrator" : name);
      expect(tool.run).toBe(original.run);
      expect(tool.spec).toEqual(original.spec);
      return tool;
    });
    expect(loaded.map(tool => tool.spec.name)).toEqual([...toolsFor[role]]);
    expect(toResponseTools(loaded.map(tool => tool.spec))).toHaveLength(loaded.length);
    if (role !== "orchestrator") expect(loaded.map(tool => tool.spec.name)).not.toContain("memory");
  }
  const file = join(home, "tools/task-orchestrator.json");
  const edited = JSON.parse(readFileSync(file, "utf8"));
  edited.description = "Local task instructions.";
  edited.input_schema.properties.action.description = "Local action help.";
  writeFileSync(file, JSON.stringify(edited));
  const loaded = editableTool(orchestratorTask, "task-orchestrator");
  const converted = toResponseTools([loaded.spec])[0]!;
  expect(converted.type).toBe("function");
  expect(JSON.stringify(converted)).toContain("Local task instructions.");
  expect(JSON.stringify(converted)).toContain("Local action help.");
  expect(JSON.stringify(converted)).toContain("never authorizes work");
  expect(JSON.stringify(converted)).toContain("only verified merged membership");
  expect(loaded.run).toBe(orchestratorTask.run);
  expect(editableTool(registry.task!).spec.description).not.toContain("Local task instructions.");
  edited.input_schema.properties.action.enum.push("unsafe_new_action");
  writeFileSync(file, JSON.stringify(edited));
  expect(() => editableTool(orchestratorTask, "task-orchestrator")).toThrow("immutable tool schema");
});
