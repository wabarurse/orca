import { describe, expect, test } from "bun:test";
import { defaults } from "../../config/config";
import { DYNAMIC_DISPATCH, rolePrompt } from "./shared";
import { ORCHESTRATOR } from "./orchestrator";
import type { Runner } from "../tmux/runner";
import { ask } from "../tools/ask";
import { message } from "../tools/message";
import { makeSpawn } from "../tools/spawn";
import { task } from "../tools/task";

describe("rolePrompt", () => {
  test("fills the config values in", () => {
    const config = { ...defaults, maxReviewRounds: 3, cyclomatic: 7, cognitive: 9 };
    expect(rolePrompt("orchestrator", config)).toContain("At most 3 review rounds; stop and report unresolved findings at the limit.");
    expect(rolePrompt("orchestrator", config)).toContain(`Approved: reviewer with "watch ci" and existing evidence`);
    expect(rolePrompt("orchestrator", { ...config, maxReviewRounds: 1 })).toContain("At most 1 review round;");
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
    expect(p).toContain(`spawn the reviewer with "watch ci" and existing check evidence`);
    expect(p).not.toContain("spawn a reviewer");
    expect(p).not.toContain("review rounds");
  });
  test("the orchestrator respawns once per [agent-exit] and stops if it repeats", () => {
    const p = rolePrompt("orchestrator", defaults);
    expect(p).toContain("`[agent-exit]`: tell the user.");
    expect(p).toContain("Otherwise respawn that agent once on the same branch with its last task");
    expect(p).toContain("if it exits the same way again, tell the user and stop.");
  });
  test("a merge notice listing conflicting PRs sends their workers to rebase onto main first, then the task flow reruns", () => {
    for (const maxReviewRounds of [0, 1, 100]) {
      const p = rolePrompt("orchestrator", { ...defaults, maxReviewRounds });
      const line = p.split("\n").find((l) => l.includes("`[agent-exit]`"))!;
      expect(line).toContain("If it lists conflicting PRs, their workers rebase onto main first, then rerun the task flow.");
      expect(line.indexOf("tell the user and stop.")).toBeLessThan(line.indexOf("conflicting PRs"));
    }
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

  // Every prompt stays under 2200 characters: it is sent with every request
  // after the provider's identity line, and a short list keeps each rule in the
  // model's attention. Long guidance belongs in a tool description (spawn, ask).
  test("each role gets its own short list", () => {
    for (const [role, maxReviewRounds] of [["orchestrator", 0], ["orchestrator", 1], ["orchestrator", 100], ["worker", 1], ["reviewer", 1]] as const) {
      const p = rolePrompt(role, { ...defaults, maxReviewRounds });
      expect(p.split("\n").filter((l) => l.startsWith("- ")).length).toBeGreaterThan(3);
      // Includes the mandatory structured review/CI dispatch protocol; the orchestrator also carries the one-sentence history and web_search pointers.
      expect(p.length).toBeLessThan(role === "orchestrator" ? 2500 : 2200);
      expect(p).not.toMatch(/\{\w+\}/);
    }
  });
});

// Prompt contracts, not a claim that arbitrary shell commands are sandboxed.
test("check ownership survives review limits, dynamic dispatch and publication handoffs", () => {
  for (const maxReviewRounds of [0, 1, 100]) {
    for (const dynamicDispatch of [false, true]) {
      const config = { ...defaults, maxReviewRounds, dynamicDispatch };
      const orch = rolePrompt("orchestrator", config);
      expect(orch).toContain("Never request a full suite, baseline runs or duplicate tests");
      expect(orch).toContain("Forward check evidence on handoff");
      expect(orch).not.toContain("spawn the worker once more");
      const worker = rolePrompt("worker", config);
      expect(worker).toContain("run only checks relevant to changed behavior");
      expect(worker).toContain("Never run the full test suite or baseline comparisons");
      expect(worker).toContain("after feedback, rerun it only if that code changed");
      expect(worker).toContain("Never retry an unchanged failure");
      expect(worker).toContain("tested commit/code state, result and saved failure-output path");
      const reviewer = rolePrompt("reviewer", config);
      expect(reviewer).toContain("Never run tests or validation commands");
      expect(reviewer).toContain("Never edit code in either mode");
      expect(reviewer).toContain("inspect only failed-check output");
      expect(reviewer).toContain("focus on the new diff and prior findings");
      expect(reviewer).toContain("Run `complexity`");
      expect(reviewer).toContain("never rerun jobs or add a local validation pass");
      expect(reviewer).toContain("match the current PR head to the worker's check evidence");
      expect(reviewer).toContain("task attention for unresolved failures or missing/stale evidence");
      expect(reviewer).not.toContain("Fix what fails");
    }
  }
  const schema = makeSpawn({} as Runner).spec.input_schema as { properties: { prompt: { description: string } } };
  expect(schema.properties.prompt.description).toContain("prior check commands, tested commit/code state, results and saved failure-output paths");
  expect(schema.properties.prompt.description).toContain("Never request full suites, baseline comparisons or duplicate tests, including in watch-ci");
  expect(task.spec.description).toContain("never rerun tests or add local validation");
  expect(task.spec.description).toContain("matching the worker's relevant-check evidence to the current clean PR head");
});

test("every role is pointed at web_search for finding sources and curl only for a known URL", () => {
  for (const role of ["orchestrator", "worker", "reviewer"] as const) {
    const p = rolePrompt(role, defaults);
    const lines = p.split("\n").filter((l) => l.includes("web_search"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("- Use `web_search` to find documentation, sources or current facts; use curl only to fetch a specific, already-known URL.");
  }
});

test("all production review flows require structured intent including zero-review CI", () => {
  for (const maxReviewRounds of [0, 1, 2]) {
    const prompt = rolePrompt("orchestrator", { ...defaults, maxReviewRounds });
    expect(prompt).toContain('reviewMode: "review" for code review');
    expect(prompt).toContain('reviewMode: "watch-ci" for CI-only validation');
    expect(prompt).toContain("Missing reviewer reviewMode is refused");
  }
});

test("reviewer watch-ci opens the PR with title and body from the first commit", () => {
  for (const dynamicDispatch of [false, true]) {
    const prompt = rolePrompt("reviewer", { ...defaults, dynamicDispatch });
    expect(prompt).toContain("open the PR with `gh pr create --fill-first` (title and body from the first commit) if there is none");
    expect(prompt.length).toBeLessThan(2200);
  }
});

describe("dynamic dispatch", () => {
  const rounds = [0, 1, 100];
  test("off leaves the orchestrator prompt exactly the base prompt; on appends one section after it", () => {
    expect(defaults.dynamicDispatch).toBe(false);
    for (const maxReviewRounds of rounds) {
      const off = rolePrompt("orchestrator", { ...defaults, maxReviewRounds, dynamicDispatch: false });
      const on = rolePrompt("orchestrator", { ...defaults, maxReviewRounds, dynamicDispatch: true });
      expect(off).toBe(rolePrompt("orchestrator", { ...defaults, maxReviewRounds }));
      expect(off.startsWith(ORCHESTRATOR.slice(0, ORCHESTRATOR.indexOf("{taskFlow}")))).toBe(true);
      expect(off.endsWith(ORCHESTRATOR.slice(ORCHESTRATOR.indexOf("{taskFlow}") + "{taskFlow}".length))).toBe(true);
      expect(off).not.toContain("Splitting work into PRs");
      expect(on).toBe(`${off}\n\n${DYNAMIC_DISPATCH}`);
      // The base keeps its budget; the section sits outside it.
      expect(off.length).toBeLessThan(2500);
      expect(on).not.toMatch(/\{\w+\}/);
    }
  });
  test("workers and reviewers never get the section", () => {
    for (const role of ["worker", "reviewer"] as const) {
      expect(rolePrompt(role, { ...defaults, dynamicDispatch: true })).toBe(rolePrompt(role, defaults));
    }
  });
  test("the section carries the user's guidance adapted to this app", () => {
    const s = DYNAMIC_DISPATCH;
    expect(s.startsWith("## Splitting work into PRs\nThe PR is the unit of work.")).toBe(true);
    expect(s).toContain("Split by what a reviewer can approve alone, never by layer.");
    expect(s).toContain("The plan table gets one row per PR.");
    // Stacks: spawn only branches from the default branch, so milestones go one after another.
    expect(s).toContain("titled `<feature> 2/5: <milestone>`");
    expect(s).toContain("Spawn only branches from the default branch, so dispatch the stack sequentially: each PR starts after the previous one merges.");
    expect(s).toContain("Every body lists the stack and marks the current PR.");
    expect(s).not.toContain("opened together");
    // Approval is defined; post-approval findings become follow-up PRs, with CI and explicit-user exceptions.
    expect(s).toContain("- Approved = the reviewer reported ready to merge.");
    expect(s).toContain("After that, new review findings, including bot or user review comments, become a follow-up PR, not another commit: register a new task and plan a new branch, started after this PR merges.");
    expect(s).toContain("CI failures go to the worker on the same branch.");
    expect(s).toContain("If the user explicitly asks for the fix on this PR, reuse the branch per spawn.");
    expect(s).toContain("Review fixes before approval stay on the same branch per the task flow, within the review-round limit.");
    expect(s).not.toContain("instead of re-spawning the worker on the same branch");
    // Title and body reach the watch-ci reviewer through the worker's commit message; checks are a brief requirement.
    expect(s).toContain("- Brief names the files, exact change, relevant checks, pattern, and PR title and body.");
    expect(s).toContain("never full suites, baseline comparisons or duplicate tests");
    expect(s).toContain("Reviewers inspect failed-check output, diff and complexity without running checks");
    expect(s).toContain("The worker writes the title and body into its commit message so the reviewer's PR uses them.");
    expect(s).toContain("- Follow each PR until it merges.");
    expect(s).not.toContain("Own the PR to merge");
    expect(s).not.toMatch(/^- Format, lint/m);
    // Terminal app; workers don't push.
    expect(s).toContain("pasted terminal output for UI");
    expect(s).not.toMatch(/screenshot/i);
    expect(s).not.toMatch(/push/i);
    for (const kept of ["Data change: expand/contract.", "Codeowner-owned migrations get their own PR.", "Behavior switch: one PR adds it dormant with tests, a second small PR turns it on.", 'If the title needs "and", split.', "Never a branch name.", "2 to 5 files, under 300 lines. Over 600 lines needs a stated reason.", "Merges alone, leaves main working, carries its own test or eval change.", "Parallel only on disjoint files; shared prerequisites ship first as their own PR, dependents start when it merges."]) expect(s).toContain(kept);
  });
});
