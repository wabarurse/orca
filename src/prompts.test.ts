import { describe, expect, test } from "bun:test";
import { defaults } from "./config";
import { rolePrompt } from "./prompts";

describe("rolePrompt", () => {
  test("fills the config values in", () => {
    const config = { ...defaults, maxReviewRounds: 3, cyclomatic: 7, cognitive: 9 };
    expect(rolePrompt("orchestrator", config)).toContain("At most 3 review rounds");
    expect(rolePrompt("reviewer", config)).toContain("cyclomatic > 7, cognitive > 9");
    expect(rolePrompt("worker", config)).not.toMatch(/\{\w+\}/);
    expect(rolePrompt("orchestrator", config)).toContain("Do not spawn, push, or change anything until the user says to execute or dispatch");
  });
  test("each role gets its own short list", () => {
    for (const role of ["orchestrator", "worker", "reviewer"] as const) {
      const p = rolePrompt(role, defaults);
      expect(p.split("\n").filter((l) => l.startsWith("- ")).length).toBeGreaterThan(3);
      expect(p.length).toBeLessThan(2000);
      expect(p).not.toMatch(/\{\w+\}/);
    }
  });
});
