// MOCKUP-PICK (throwaway): the shared sample tasks for the task-list previews. Fixture data only.
import type { Task } from "../src/protocol/task";

export const NOW = Date.now(), at = (minutes: number) => new Date(NOW - minutes * 60000).toISOString();
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const head = (c: string) => c.repeat(40);
const pr = (n: number, h = "a") => ({ repository: "wabarurse/orca", number: n, url: `https://github.com/wabarurse/orca/pull/${n}`, head: head(h) });
const run = (role: "worker" | "reviewer", state: "started" | "stopped" | "failed", minutes: number) =>
  ({ id: `${role}-${minutes}`, agent: `${role}-x`, role, state, preparedAt: at(minutes + 1), startedAt: at(minutes), ...(state === "started" ? {} : { endedAt: at(minutes - 5) }) });
function task(n: number, name: string, extra: Partial<Task> = {}, minutes = n * 37): Task {
  return { id: id(n), number: n, name, summary: `Summary for ${name.toLowerCase()}.`, branch: `feat-${n}`, status: "queued",
    createdAt: at(minutes + 600), updatedAt: at(minutes), revision: 1, dependsOn: [], runs: [], history: [], ...extra };
}
const merged = (n: number, h: string) => ({ reason: "merged" as const, mergedAt: at(3000), archivedAt: at(2990), pr: pr(n, h) });

export const SAMPLE: Task[] = [
  task(1, "Structure orchestrator rolling memory", { archive: merged(171, "b"), pr: pr(171, "b"), runs: [run("worker", "stopped", 3100), run("reviewer", "stopped", 3050)] }, 2990),
  task(2, "Keep slow work out of the project state lock", { archive: merged(172, "c"), pr: pr(172, "c"), removedAt: at(100) }, 2400),
  task(3, "Delete questions from the Inbox when outdated or answered in chat", { status: "working", dependsOn: [id(1)], runs: [run("worker", "started", 12)] }, 2),
  task(4, "read returns images; actionable write-exists error", { status: "reviewing", runs: [run("worker", "stopped", 90), run("reviewer", "started", 8)] }, 8),
  task(5, "/agents hides finished agents and can remove rows", { status: "reviewing", pr: pr(181, "d"),
    publication: { pr: pr(181, "d"), state: "OPEN", observedAt: at(30) }, checkpoints: { prOpenAt: at(30) }, runs: [run("worker", "stopped", 200), run("reviewer", "stopped", 40)] }, 30),
  task(6, "Provider timeout fix with jittered backoff", { status: "ready_to_merge", pr: pr(179, "e"),
    publication: { pr: pr(179, "e"), state: "OPEN", observedAt: at(300) }, readiness: { head: head("e"), run: "reviewer-50", validatedAt: at(290), validation: "bun run check passed; 2 review rounds", checks: "passed" },
    runs: [run("worker", "stopped", 600), run("reviewer", "stopped", 400), run("reviewer", "stopped", 300)] }, 290),
  task(7, "Compaction cost vs recall experiment", { status: "working", attention: { kind: "waiting", reason: "Waiting on the user's backoff decision" }, runs: [run("worker", "stopped", 900)] }, 880),
  task(8, "Rebuild the markdown table renderer for narrow terminals, keeping wide-character alignment and soft-wrapped cells readable everywhere", {
    status: "working", attention: { kind: "blocked", reason: "Needs a decision: drop column borders below 60 cols?" }, runs: [run("worker", "failed", 1500)] }, 1500),
  task(9, "Migrate legacy task ledger", { attention: { kind: "cancelled", reason: "Superseded by the SQLite store" } }, 4000),
  task(10, "Hosted CI for PRs", { status: "reviewing", pr: pr(150, "f"), publication: { pr: pr(150, "f"), state: "CLOSED", observedAt: at(5000) },
    attention: { kind: "closed", reason: "PR closed without merge" }, runs: [run("worker", "stopped", 5200)] }, 5000),
  task(11, "Worker crash notice", { status: "working", attention: { kind: "unknown", reason: "Run vanished; no exit record" }, runs: [run("worker", "failed", 60)] }, 60),
  task(12, "Document the task overlay", { dependsOn: [id(3), id(5)] }, 20),
  task(13, "Ship task overlay redesign", { dependsOn: [id(12)] }, 19),
  task(14, "Profile footer redraws", {}, 9000),
];

