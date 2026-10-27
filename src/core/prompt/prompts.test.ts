import { REVIEWER } from "./reviewer";
import { afterAll, describe, expect, test } from "bun:test";
import { defaults } from "../../config/config";
import { DYNAMIC_DISPATCH, rolePrompt } from "./shared";
import { definition } from "../definitions/files";
import { ORCHESTRATOR } from "./orchestrator";
import type { Runner } from "../tmux/runner";
import { ask } from "../tools/ask";
import { message } from "../tools/message";
import { makeSpawn } from "../tools/spawn";
import { task } from "../tools/task";

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const promptHome = mkdtempSync(join(tmpdir(), "orca-prompt-definitions-"));
const previousHome = process.env.ORCA_HOME;
process.env.ORCA_HOME = promptHome;
afterAll(() => { if (previousHome === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previousHome; rmSync(promptHome, { recursive: true, force: true }); });

const terminology = "Use the user’s terminology for concepts and features. If an internal term differs, explain the distinction rather than silently substituting it.";

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
      expect(p).toMatch(/For tracked shipping code, show each task's plan table/);
      expect(p).toContain("Register new tracked shipping work via `task`");
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

  // Role budgets bound recurring context cost: prompts are sent with every request
  // after the provider's identity line, and a short list keeps each rule in the
  // model's attention. Long guidance belongs in a tool description (spawn, ask).
  test("each role gets its own short list", () => {
    for (const [role, maxReviewRounds] of [["orchestrator", 0], ["orchestrator", 1], ["orchestrator", 100], ["worker", 1], ["reviewer", 1]] as const) {
      const p = rolePrompt(role, { ...defaults, maxReviewRounds });
      expect(p.split("\n").filter((l) => l.startsWith("- ")).length).toBeGreaterThan(3);
      // Includes review/CI dispatch and explicit direct-operation precedence, safety and outcome guidance.
      // The memory/numbered-task pointer is included in the orchestrator budget;
      // shared terminology remains additional to each role's budget.
      expect(p.length - terminology.length - 2).toBeLessThan(role === "orchestrator" ? 4600 : 2200);
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
  expect(JSON.stringify(task.spec.input_schema)).toContain("no reruns/local validation");
  expect(JSON.stringify(task.spec.input_schema)).toContain("matches existing worker checks and review findings to the current clean PR head");
});

test("CI monitoring yields pending instead of blocking across dispatch modes", async () => {
  for (const maxReviewRounds of [0, 1, 100]) {
    for (const dynamicDispatch of [false, true]) {
      const config = { ...defaults, maxReviewRounds, dynamicDispatch };
      for (const role of ["orchestrator", "reviewer"] as const) {
        const prompt = rolePrompt(role, config);
        expect(prompt).toContain("one-shot");
        expect(prompt).toContain("no --watch");
        expect(prompt).toContain("polling loops or");
        expect(prompt).toContain("Return control/check inbox; report pending");
        expect(prompt).not.toContain("gh pr checks --watch");
      }
      const reviewer = rolePrompt("reviewer", config);
      expect(reviewer).toContain("`gh pr checks` with bash timeout_ms: 10000");
      expect(reviewer).toContain("never rerun jobs or add a local validation pass");
      expect(reviewer).toContain("match the current PR head to the worker's check evidence on a clean head");
      expect(reviewer).toContain("require required hosted checks and approval satisfied");
      expect(reviewer).toContain("No hosted checks is not a pass");
      expect(reviewer).toContain("Pending/unknown is not ready: task attention waiting, report PR/head/status");
    }
  }
  const docs = await Bun.file(new URL("../../../docs/REFERENCE.md", import.meta.url)).text();
  expect(docs).not.toContain("gh pr checks --watch");
  expect(docs).toContain("bash `timeout_ms: 10000`");
  expect(docs).toContain("not shell-command enforcement");
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
    expect(prompt).toContain("use `task` publish (gated push/create; title and body from the first commit)");
    expect(prompt.length - terminology.length - 2).toBeLessThan(2200);
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
      expect(off.endsWith(`${ORCHESTRATOR.slice(ORCHESTRATOR.indexOf("{taskFlow}") + "{taskFlow}".length)}\n\n${terminology}`)).toBe(true);
      expect(off).not.toContain("Splitting work into PRs");
      expect(on).toBe(`${off}\n\n${DYNAMIC_DISPATCH}`);
      // The role base keeps its budget; shared terminology and dispatch sit outside it.
      expect(off.length - terminology.length - 2).toBeLessThan(4600);
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
    expect(s).toContain("not maximum PR count");
    expect(s).toContain("Before dispatch, report the PR count, maximum merge depth, and immediately runnable task numbers.");
    expect(s).toContain("the longest prerequisite path in nodes; independent tasks have depth 1");
    expect(s).toContain("Task # · branch · scope · depends on");
    expect(s).toContain('Use numbered tasks for dependencies, "none" for roots');
    expect(s).toContain('"<branch> (existing)" for reused branches');
    expect(s).toContain("Justify every edge with a concrete code, migration or safety prerequisite; a shared subject is not an edge.");
    expect(s).toContain("Default to branches from the default branch; explicit DAG dependents may use checkpoint baseCommit for local unpublished work, but publish only after all transitive prerequisites merge.");
    expect(s).toContain("Independent milestones run in parallel on disjoint files, including build registrations");
    expect(s).not.toContain("dispatch the stack sequentially");
    expect(s).not.toContain("each PR starts after the previous one merges");
    expect(s).not.toContain('If the title needs "and", split.');
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
    for (const kept of ["Data change: expand/contract.", "Codeowner-owned migrations get their own PR.", "Never a branch name.", "Target 2 to 5 files, under 300 changed lines, without artificial PR inflation.", "Over 600 changed lines needs a stated reason.", "Merges alone, leaves main working, carries its own test or eval change."]) expect(s).toContain(kept);
  });
  test("contracts and rollout gates enable safe concurrency without artificial layers", () => {
    const s = DYNAMIC_DISPATCH;
    expect(s).toContain("Agree shared request/result/error contracts before parallel UI and backend work.");
    expect(s).toContain("Use an existing or agreed contract; if a shared contract PR is necessary, it must merge first.");
    expect(s).toContain("No competing interfaces or empty scaffolding.");
    expect(s).toContain("Contracts do not justify layered PRs that cannot merge alone.");
    expect(s).toContain("Prefer disabled implementations with tests that can merge independently; apply rollout prerequisites to activation, not automatically to implementation.");
    expect(s).toContain("Keep genuine safety prerequisites even for disabled code.");
    expect(s).toContain("Preserve genuine migration, deployment and safety gates.");
    expect(s).toContain(`Each body names its merge gate ("after PR N's deploy rolls out").`);
    expect(s).toContain("one coherent, independently testable behavior");
    expect(s).toContain("tasks 1 and 2 (depth 1); activation task 3 depends on 1 and 2 (depth 2)");
    expect(s).toContain("waits for the required deploy before switching reads or dropping old storage");
  });
});

 test("reviewer records publication before CI without relaxing readiness", () => {
  expect(REVIEWER).toContain("immediately after publication, before waiting for CI or validation");
  expect(REVIEWER).toContain('"PR is out"');
  expect(REVIEWER).toContain("require required hosted checks and approval satisfied");
});

 test("all role system prompts use the user's terminology without silently equating internal terms", () => {
  for (const role of ["orchestrator", "worker", "reviewer"] as const) {
    for (const dynamicDispatch of [false, true]) {
      const prompt = rolePrompt(role, { ...defaults, dynamicDispatch });
      expect(prompt).toContain("Use the user’s terminology for concepts and features. If an internal term differs, explain the distinction rather than silently substituting it.");
      if (role === "reviewer") expect(prompt).toContain("never grants merge permission");
    }
  }
});

// Composition/provenance contracts, not a claim about model intent inference.
test("direct execution upgrades known defaults but preserves deliberate and ambiguous local restrictions", () => {
  rolePrompt("orchestrator", defaults);
  const file = join(promptHome, "prompts/orchestrator.md");
  const original = readFileSync(file, "utf8");
  const oldDefault = "Default task flow: always dispatch a worker and reviewer.";
  const explicit = "Always use a worker and reviewer for every operation. Keep my custom preference.";
  try {
    // Record a byte-identical shipped baseline, as the existing loader does.
    definition("prompts/orchestrator.md", oldDefault);
    expect(readFileSync(file, "utf8")).toBe(oldDefault);
    const upgraded = rolePrompt("orchestrator", defaults);
    expect(upgraded).not.toContain(oldDefault);
    expect(readFileSync(file, "utf8")).toBe(ORCHESTRATOR);
    // Identical wording without matching provenance is not guessed to be a default.
    for (const local of [explicit, oldDefault]) {
      writeFileSync(file, local);
      for (const dynamicDispatch of [false, true]) {
        const p = rolePrompt("orchestrator", { ...defaults, dynamicDispatch });
        expect(p).toContain(local);
        expect(p).toContain("one-off operations, investigation, explanations and messages to existing agents may be handled directly");
        expect(p).toContain("narrows default task-flow and dynamic-dispatch guidance to tracked shipping code");
        expect(p).toContain("Preserve explicit user approval, review and workflow limits, including deliberate local guidance, unless the user changes them");
        expect(p).toContain("Do not silently dismiss ambiguous local restrictions as stale defaults");
        expect(p).toContain("obey the tool's task identity and branch requirements");
        expect(p).toContain("never auto-merge");
        expect(p).toContain("Shipping repository code still uses the tracked task flow");
        expect(p).toContain("new access, billing or deployment boundary");
        expect(p).toContain("Verify the actual requested outcome");
        expect(p).toContain("Continue unblocked authorized work");
        expect(p.indexOf(local)).toBeLessThan(p.indexOf("Execution scope and precedence"));
      }
      expect(readFileSync(file, "utf8")).toBe(local);
    }
  } finally { writeFileSync(file, original); }
});
