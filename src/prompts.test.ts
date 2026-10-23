import { describe, expect, test } from "bun:test";
import { defaults } from "./config";
import { rolePrompt } from "./prompts";
import type { Runner } from "./runner";
import { ask } from "./tools/ask";
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
    expect(d).toContain("Reuse the same taskId and branch");
    expect(d).toContain("user-requested fixes after a ready report");
    expect(d).toContain("CI or PR publication does not require a fresh branch");
    expect(d).toContain("refresh its PR state with task pr before resuming");
    expect(d).toContain("reviewer pushes to the same PR and validates its updated head");
    expect(d).toContain("Do not register a new task or use a temporary branch/cherry-pick workaround");
    expect(d).not.toContain("only before it has gone to CI or a PR");
    expect(d).not.toContain("or the existing branch has gone to CI or a PR");
    expect(d).toContain("Never spawn on a branch whose PR is merged");
    expect(d).toContain("One agent works on a branch at a time");
    expect(d).toContain('"<branch> (existing)"');
    for (const maxReviewRounds of [0, 1, 100]) {
      const p = rolePrompt("orchestrator", { ...defaults, maxReviewRounds });
      expect(p).toMatch(/Reuse vs new: see spawn/);
      expect(p).toContain('branch · what it does · depends on; reused: "<branch> (existing)"');
      expect(p).toContain("(see ask)");
      expect(p).toContain("reused branches run the full task flow");
    }
  });

  test("a restarted worker takes the newest message as its next instruction, not always as review feedback", () => {
    const w = rolePrompt("worker", defaults);
    expect(w).not.toMatch(/started again[^\n]*it is review feedback/i);
    expect(w).toMatch(/started again[^\n]*follow-up task/i);
    expect(w).toContain("later messages are follow-ups");
  });

  // Source-level policy contracts, not a live-model test of intent inference.
  test("clear contextual requests authorize only their scope without magic words or reconfirmation", () => {
    for (const maxReviewRounds of [0, 1, 100]) {
      const p = rolePrompt("orchestrator", { ...defaults, maxReviewRounds });
      expect(p).toMatch(/Clear user requests in context/);
      expect(p).toContain('"fix X"'); // An ordinary imperative is a request, not a special command.
      expect(p).toMatch(/authorize only that scope/);
      expect(p).toMatch(/no magic words\/reconfirmation/);
      expect(p).toMatch(/not discussion, quotes or mere possibility/);
      expect(p).not.toMatch(/Before spawning, changing or pushing, wait/);
      expect(p).toContain('"Execute"/"dispatch" alone means the whole plan last shown');
    }
  });

  test("request authorization retains the plan, registration, review and lifecycle boundaries", () => {
    for (const maxReviewRounds of [0, 1, 100]) {
      const p = rolePrompt("orchestrator", { ...defaults, maxReviewRounds });
      expect(p).toMatch(/Show each task's plan table/);
      expect(p).toContain("Register new work via `task`");
      expect(p).toContain("reuse taskId for fixes");
      expect(p).toMatch(/spawn a worker → it reports → spawn (?:the|a) reviewer/);
      expect(p).toMatch(/it reports ready to merge → tell the user/);
      expect(p).toContain("Never read or edit a worker's worktree");
      expect(p).toContain("One agent per branch");
      expect(p).toContain('quoting the source: From worker-xyz: "<message>"');
      expect(p).toContain("no respawn or tool retry without explicit user authorization");
    }
  });

  test("ask still reserves clarification for genuine unresolved decisions, not routine approvals", () => {
    for (const maxReviewRounds of [0, 1, 100]) {
      const p = rolePrompt("orchestrator", { ...defaults, maxReviewRounds });
      const guidance = p.split("\n").find((line) => line.includes("(see ask)"))!;
      expect(guidance).toMatch(/only for necessary unresolved decisions/);
      expect(guidance).toMatch(/not routine approved work/);
    }
    // Detailed safety guidance remains in the referenced tool, not duplicated in the prompt.
    const guidance = ask.spec.description ?? "";
    expect(guidance).toContain("currently unresolved decision");
    expect(guidance).toContain("materially affects scope/results");
    expect(guidance).toContain("destructive/data-loss risk");
    expect(guidance).toContain("new access, credentials, provider or billing beyond existing authorization");
    expect(guidance).toContain("Do not treat real scope expansion or destructive changes as routine");
    expect(guidance).toContain("Skip, silence and closing the panel never apply it");
    expect(guidance).toContain("Never use a default, Skip or silence to authorize destructive steps");
  });

  // Every prompt stays under 2000 characters: it is sent with every request
  // after the provider's identity line, and a short list keeps each rule in the
  // model's attention. Long guidance belongs in a tool description (spawn, ask).
  test("each role gets its own short list", () => {
    for (const [role, maxReviewRounds] of [["orchestrator", 0], ["orchestrator", 1], ["orchestrator", 100], ["worker", 1], ["reviewer", 1]] as const) {
      const p = rolePrompt(role, { ...defaults, maxReviewRounds });
      expect(p.split("\n").filter((l) => l.startsWith("- ")).length).toBeGreaterThan(3);
      // Includes the mandatory structured review/CI dispatch protocol.
      expect(p.length).toBeLessThan(2200);
      expect(p).not.toMatch(/\{\w+\}/);
    }
  });
});

test("all production review flows require structured intent including zero-review CI", () => {
  for (const maxReviewRounds of [0, 1, 2]) {
    const prompt = rolePrompt("orchestrator", { ...defaults, maxReviewRounds });
    expect(prompt).toContain('reviewMode: "review" for code review');
    expect(prompt).toContain('reviewMode: "watch-ci" for CI-only validation');
    expect(prompt).toContain("Missing reviewer reviewMode is refused");
  }
});
