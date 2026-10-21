import { describe, expect, test } from "bun:test";
import { defaults } from "./config";
import { rolePrompt } from "./prompts";
import type { Runner } from "./runner";
import { message } from "./tools/message";
import { ask } from "./tools/ask";
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
  test("the orchestrator respawns once per [agent-exit] and stops if it repeats", () => {
    const p = rolePrompt("orchestrator", defaults);
    expect(p).toContain("`[agent-exit]`: tell the user.");
    expect(p).toContain("Otherwise respawn that agent once on the same branch with its last task");
    expect(p).toContain("if it exits the same way again, tell the user and stop.");
  });
  test("a merged PR's [agent-exit] is not respawned; what waited on the branch starts, and nothing is cleaned up by hand", () => {
    for (const maxReviewRounds of [0, 1, 100]) {
      const p = rolePrompt("orchestrator", { ...defaults, maxReviewRounds });
      const line = p.split("\n").find((l) => l.includes("`[agent-exit]`"))!;
      expect(line).toContain(`If it says "PR … merged", that branch is done: don't respawn; start what was waiting on it. Otherwise respawn`);
      expect(line.indexOf("PR … merged")).toBeLessThan(line.indexOf("respawn that agent"));
      expect(p).not.toMatch(/worktree remove|delete the branch|clean ?up/i);
      expect(p).toContain("The user's message is input, not a verdict.");
      expect(p).toContain("propose an alternative before acting");
      expect(p).toContain("agent status columns: agent · branch · state · last report · next step");
    }
  });

  test("reuse or a new branch: the rule lives in spawn's description, the orchestrator prompt points at it", () => {
    const d = makeSpawn({} as Runner).spec.description ?? "";
    expect(d).toMatch(/^- Reuse /m);
    expect(d).toMatch(/^- Start a new branch /m);
    expect(d).toContain('"<branch> (existing)"');
    for (const maxReviewRounds of [0, 1, 100]) {
      const p = rolePrompt("orchestrator", { ...defaults, maxReviewRounds });
      expect(p).toContain("Decide reuse vs a new branch per task (see spawn)");
      expect(p).toContain('branch · what it does · depends on; a reused branch reads "<branch> (existing)"');
      expect(p).toContain("(see ask)");
      expect(p).toContain("a reused branch's new task runs the whole task flow anew");
    }
  });

  test("a restarted worker takes the newest message as its next instruction, not always as review feedback", () => {
    const w = rolePrompt("worker", defaults);
    expect(w).not.toMatch(/started again[^\n]*it is review feedback/i);
    expect(w).toMatch(/started again[^\n]*follow-up task/i);
    expect(w).toContain("later messages are follow-ups");
  });

  test("ask's description carries what the prompt no longer says: batch, default, keep working", () => {
    const d = ask.spec.description ?? "";
    expect(d).toMatch(/batch/i);
    expect(d).toMatch(/default/i);
    expect(d).toMatch(/keep working/i);
  });

  // Every prompt stays under 2000 characters: it is sent with every request
  // after the provider's identity line, and a short list keeps each rule in the
  // model's attention. Long guidance belongs in a tool description (spawn, ask).
  test("each role gets its own short list", () => {
    for (const [role, maxReviewRounds] of [["orchestrator", 0], ["orchestrator", 1], ["orchestrator", 100], ["worker", 1], ["reviewer", 1]] as const) {
      const p = rolePrompt(role, { ...defaults, maxReviewRounds });
      expect(p.split("\n").filter((l) => l.startsWith("- ")).length).toBeGreaterThan(3);
      expect(p.length).toBeLessThan(2000);
      expect(p).not.toMatch(/\{\w+\}/);
    }
  });
});
