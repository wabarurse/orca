import { describe, expect, test } from "bun:test";
import { defaults, MAX_REVIEW_ROUNDS } from "./config";
import { rolePrompt } from "./prompts";
import type { Runner } from "./runner";
import { complexity } from "./tools/complexity";
import { task } from "./tools/task";
import { ask } from "./tools/ask";
import { message } from "./tools/message";
import { makeSpawn } from "./tools/spawn";

describe("rolePrompt", () => {
  test("fills the config values in", () => {
    const config = { ...defaults, maxReviewRounds: 3, cyclomatic: 7, cognitive: 9 };
    expect(rolePrompt("orchestrator", config)).toContain("At most 3 review rounds: if review 3 still finds problems, worker fixes once");
    expect(rolePrompt("orchestrator", config)).toContain(`then "watch ci" with no further review; tell the user what remains`);
    expect(rolePrompt("orchestrator", { ...config, maxReviewRounds: 1 })).toContain("At most 1 review round: if review 1");
    expect(rolePrompt("orchestrator", config)).toContain("spawn a reviewer");
    expect(rolePrompt("reviewer", config)).toContain("cyclomatic > 7, cognitive > 9");
    expect(rolePrompt("worker", config)).not.toMatch(/\{\w+\}/);
  });
  test("reports retain all evidence, but skipped checks do not need boilerplate", () => {
    for (const role of ["worker", "reviewer"] as const) {
      const p = rolePrompt(role, defaults);
      expect(p).toContain("no length limit");
      expect(p).not.toMatch(/(?:short|brief|concise|terse) report/i);
      expect(p.split("no length limit").length - 1).toBeLessThanOrEqual(1);
    }
    for (const maxReviewRounds of [0, 1, MAX_REVIEW_ROUNDS]) {
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
    expect(p).toContain(`spawn the reviewer with "watch ci" (no code review)`);
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
    for (const maxReviewRounds of [0, 1, MAX_REVIEW_ROUNDS]) {
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
    for (const maxReviewRounds of [0, 1, MAX_REVIEW_ROUNDS]) {
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
    for (const maxReviewRounds of [0, 1, MAX_REVIEW_ROUNDS]) {
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
    for (const maxReviewRounds of [0, 1, MAX_REVIEW_ROUNDS]) {
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
    for (const maxReviewRounds of [0, 1, MAX_REVIEW_ROUNDS]) {
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

  // Every prompt stays under 2200 characters: it is sent with every request
  // after the provider's identity line, and a short list keeps each rule in the
  // model's attention. Long guidance belongs in a tool description (spawn, ask).
  test("each role gets its own short list", () => {
    for (const [role, maxReviewRounds] of [["orchestrator", 0], ["orchestrator", 1], ["orchestrator", MAX_REVIEW_ROUNDS], ["worker", 1], ["reviewer", MAX_REVIEW_ROUNDS]] as const) {
      const p = rolePrompt(role, { ...defaults, maxReviewRounds });
      expect(p.split("\n").filter((l) => l.startsWith("- ")).length).toBeGreaterThan(3);
      // Includes structured modes and proportionate review; do not grow the budget.
      expect(p.length).toBeLessThan(2200);
      expect(p).not.toMatch(/\{\w+\}/);
    }
  });
});

test("all production review flows require structured intent including zero-review CI", () => {
  for (const maxReviewRounds of [0, 1, 2]) {
    const prompt = rolePrompt("orchestrator", { ...defaults, maxReviewRounds });
    expect(prompt).toContain('reviewMode: "review" for code review');
    expect(prompt).toContain('reviewMode: "watch-ci" for publication/validation');
    expect(prompt).toContain("Missing reviewer reviewMode is refused");
  }
});

// These assert policy delivered to the model, not live-model routing/compliance.
describe("proportionate review policy", () => {
  test("positive budgets permit justified editorial watch-ci without requiring fake review rounds", () => {
    const guidance = makeSpawn({} as Runner).spec.description!;
    for (const maxReviewRounds of [1, MAX_REVIEW_ROUNDS]) {
      const p = rolePrompt("orchestrator", { ...defaults, maxReviewRounds });
      expect(p).toContain('Trivial editorial changes may go directly to "watch ci" with a risk rationale (see spawn)');
      expect(p).toContain(`At most ${maxReviewRounds} review`);
      expect(p).toContain('then "watch ci" with no further review; tell the user what remains');
      expect(p).toContain("complexity numbers only where relevant");
      expect(p).not.toContain("reports a review and complexity numbers");
    }
    expect(guidance).toContain("actual diff and worker evidence, not extensions");
    expect(guidance).toContain("Pure wording/formatting in README/docs/comments");
    expect(guidance).toContain("bounded requested-text/link validation, with a risk rationale");
    expect(guidance).toContain("Only explicitly tagged review dispatches count");
    expect(guidance).toContain("never infer rounds from prose");
    expect(guidance).toContain("0 disables code-review rounds, not validation");
    expect(guidance).toContain("review-budget state, including any explicitly exhausted cap");
  });

  test("even a dispatched editorial review is bounded, while semantic Markdown is not automatically harmless", () => {
    for (const role of ["worker", "reviewer"] as const) {
      const p = rolePrompt(role, defaults);
      expect(p).toContain("actual diff");
      expect(p).toContain("Pure wording/formatting in README/docs/comments");
      expect(p).toContain("requested-text/link checks");
      expect(p).toContain("Behavior, security, config, agent instructions or executable examples (even in Markdown)");
      expect(p).toContain("file extension");
      expect(p).not.toContain("the project's tests and checks pass locally");
    }
    const reviewer = rolePrompt("reviewer", defaults);
    expect(reviewer).toContain("no complexity or full app suite");
    expect(reviewer).toContain("need substantive risk review and relevant checks");
    expect(reviewer).toContain("Briefly explain skipped checks, no N/A table or invented metrics");
    expect(reviewer).not.toContain("verdict, complexity table");
    expect(makeSpawn({} as Runner).spec.description).toContain("agent instructions or executable examples (even in .md)");
  });

  test("complexity is conditional on changed logic, with config thresholds and accurate baseline/unknown reporting", () => {
    const p = rolePrompt("reviewer", { ...defaults, cyclomatic: 7, cognitive: 9 });
    expect(p).toContain("Use `complexity` for changed JS/TS logic where relevant");
    expect(p).toContain("not unchanged functions merely in touched files");
    expect(p).toContain("When applicable, report functions over thresholds (cyclomatic > 7, cognitive > 9) with name/file and both measured scores");
    expect(p).not.toContain("Run the `complexity` tool");
    const d = complexity.spec.description!;
    expect(d).toContain("not automatically for every review or touched file");
    expect(d).toContain("semantic prompt/config changes and executable examples still need substantive review");
    expect(d).toContain("Prefer explicit `files`");
    expect(d).toContain("Scores all functions in selected files, NOT just changed functions");
    expect(d).toContain("base selects files, it does not compute metric deltas");
    expect(d).toContain("Unchanged functions are baseline context, not new findings");
    expect(d).toContain("Unsupported languages, parse failures or no functions are not zero complexity or proof of safety");
  });

  test("watch-ci returns misclassified material changes, respects zero/cap and never waives exact-head evidence", () => {
    for (const maxReviewRounds of [0, 1, MAX_REVIEW_ROUNDS]) {
      const p = rolePrompt("reviewer", { ...defaults, maxReviewRounds });
      expect(p).toContain("Follow the dispatched reviewMode: review or watch-ci");
      expect(p).toContain("if an editorial diff proves substantive or material changes lack review");
      expect(p).toContain(`return to the orchestrator before readiness when maxReviewRounds (${maxReviewRounds}) > 0`);
      expect(p).toContain("unless explicitly sent after exhausting that cap");
      expect(p).toContain("never silently skip review or add rounds");
      expect(p).toContain("No CI still requires proportionate local validation");
      expect(p).toContain("`task` pr after publication");
      expect(p).toContain("current clean PR head with validated=true and validation evidence");
      expect(p).toContain("No checks is not validation");
      expect(p).toContain("Review-only never asserts readiness");
      expect(p).toContain("Use attention for failures/uncertainty");
    }
    expect(task.spec.description).toContain("current clean PR head");
    expect(task.spec.description).toContain("No checks is not validation");
  });
});
