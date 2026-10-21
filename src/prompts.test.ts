import { describe, expect, test } from "bun:test";
import { defaults } from "./config";
import { rolePrompt } from "./prompts";
import type { Runner } from "./runner";
import { message } from "./tools/message";
import { makeSpawn } from "./tools/spawn";

describe("rolePrompt", () => {
  test("fills the config values in", () => {
    const config = { ...defaults, maxReviewRounds: 3, cyclomatic: 7, cognitive: 9 };
    expect(rolePrompt("orchestrator", config)).toContain("At most 3 review rounds: if review 3 still finds problems, spawn the worker once more");
    expect(rolePrompt("orchestrator", config)).toContain(`then the reviewer with "watch ci" and no further review, and tell the user what was left open`);
    expect(rolePrompt("orchestrator", { ...config, maxReviewRounds: 1 })).toContain("At most 1 review round: if review 1");
    expect(rolePrompt("orchestrator", config)).toContain("spawn a reviewer");
    expect(rolePrompt("reviewer", config)).toContain("cyclomatic > 7, cognitive > 9");
    expect(rolePrompt("worker", config)).not.toMatch(/\{\w+\}/);
    expect(rolePrompt("orchestrator", config)).toContain("Do not spawn, push, or change anything until the user says to execute or dispatch");
  });
  test("reports to the orchestrator are full; only the user gets the concise version", () => {
    for (const role of ["worker", "reviewer"] as const) {
      const p = rolePrompt(role, defaults);
      expect(p).not.toMatch(/\b(short|brief|concise|terse)\b/i);
      expect(p.split("no length limit").length - 1).toBeLessThanOrEqual(1);
    }
    for (const maxReviewRounds of [0, 1, 100]) {
      const orch = rolePrompt("orchestrator", { ...defaults, maxReviewRounds });
      expect(orch.match(/concise/g)?.length).toBe(1);
      expect(orch).toContain("concise with the user");
      expect(orch.split("no length limit").length - 1).toBeLessThanOrEqual(1);
    }
    expect(message.spec.description).toContain("complete");
    const spawn = makeSpawn({} as Runner).spec.input_schema as { properties: { prompt: { description: string } } };
    expect(spawn.properties.prompt.description).toContain("in full");
  });
  test("0 rounds skips review and goes straight to watch ci", () => {
    const p = rolePrompt("orchestrator", { ...defaults, maxReviewRounds: 0 });
    expect(p).toContain(`spawn the reviewer with only the instruction "watch ci"`);
    expect(p).not.toContain("spawn a reviewer");
    expect(p).not.toContain("review rounds");
    expect(p).toContain("Do not spawn, push, or change anything until the user says to execute or dispatch");
  });
  test("each role gets its own short list", () => {
    for (const [role, maxReviewRounds] of [["orchestrator", 0], ["orchestrator", 1], ["orchestrator", 100], ["worker", 1], ["reviewer", 1]] as const) {
      const p = rolePrompt(role, { ...defaults, maxReviewRounds });
      expect(p.split("\n").filter((l) => l.startsWith("- ")).length).toBeGreaterThan(3);
      expect(p.length).toBeLessThan(2000);
      expect(p).not.toMatch(/\{\w+\}/);
    }
  });
});
