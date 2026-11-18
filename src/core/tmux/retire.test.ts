import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../../config";
import { ensureProject } from "../agent-loop/orc/orchestrator";
import { ensureWorktree } from "./runner";
import { allTasks, registerTask } from "../data/tasks";
import { ask } from "../data/inbox/questions";
import { ensureBubble, joinBubble } from "../data/bubbles";
import { directories, workViews, workspaces } from "../data/projects";
const { projectArchive } = directories;
import { execution } from "../data/projects/lifecycle";
import { saveProcess, readProcess, processDirectory, type ProcessRecord } from "../data/processes";
import { cleanStorage } from "../../cli/scripts/clean";
import { archiveBubble, archiveProject, describeArchive, restoreProject, stopTree, type RetireOptions } from "./retire";
import type { Sessions } from "./process-view";

// Isolated home and checkout: never a real conversation, tmux server or agent.
let root: string, repo: string, previous: string | undefined;
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (r.exitCode) throw Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  root = realpathSync(mkdtempSync(join(tmpdir(), "orca-retire-")));
  process.env.ORCA_HOME = join(root, "state");
  repo = join(root, "source"); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "file"), "x\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "fixture");
  await ensureProject("p", repo);
  await ensureProject("q", repo);
});
afterEach(() => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  rmSync(root, { recursive: true, force: true });
});

/** A fake of everything that runs: agent windows that close by themselves after `exitAfter` looks (never, when Infinity). */
function running(agents: string[], exitAfter = 1) {
  const log: string[] = [], windows = new Map<string, string[]>([["p", [...agents]], ["q", []]]);
  let looks = 0;
  const none: Sessions = { panes: async () => [], tail: async () => "", kill: async name => { log.push(`kill-session ${name}`); } };
  const options: RetireOptions = {
    live: async project => { if (project === "p" && ++looks > exitAfter && exitAfter !== Infinity) windows.set("p", []); return windows.get(project) ?? []; },
    stop: async project => { log.push(`stop-daemon ${project}`); },
    kill: async project => { log.push(`kill-idle ${project}`); },
    killWindow: async (project, window) => { log.push(`kill-window ${project}/${window}`); windows.set(project, (windows.get(project) ?? []).filter(w => w !== window)); },
    sessions: none, graceMs: 400, sleep: async () => { await Bun.sleep(5); },
  };
  return { options, log };
}

test("stopping asks first and waits: agents that exit by themselves are never ended, and the daemon stops last", async () => {
  const { options, log } = running(["worker-feat"]);
  const report = await stopTree("p", options);
  expect(report).toEqual({ agents: ["worker-feat"], forced: [], commands: 0, problems: [] });
  expect(execution.stopped("p")).toBe(true); // the durable barrier: nothing new starts
  expect(log).toEqual(["stop-daemon p", "kill-idle p"]); // no window was closed
  expect(execution.stopped("q")).toBe(false);
});

test("an agent still alive after the wait has its window closed, and the report says so", async () => {
  const { options, log } = running(["worker-stuck", "reviewer-stuck"], Infinity);
  const report = await stopTree("p", options);
  expect(report.forced).toEqual(["worker-stuck", "reviewer-stuck"]);
  expect(log).toEqual(["kill-window p/worker-stuck", "kill-window p/reviewer-stuck", "stop-daemon p", "kill-idle p"]);
  await expect(stopTree("p", { ...options, live: async () => null })).rejects.toThrow("cannot check live agents; nothing was stopped");
});

test("a running command gets its stop file, and one that never stops is reported, not hidden", async () => {
  const at = new Date().toISOString(), id = "00000000-0000-4000-8000-000000000001";
  const record: ProcessRecord = { id, project: "p", owner: "worker-feat", role: "worker", cwd: repo, command: "bun run stack", createdAt: at, updatedAt: at,
    state: "running", timeoutMs: 0, maxBytes: 0, notify: false, events: [] };
  await saveProcess(record);
  const { options } = running([]);
  const report = await stopTree("p", { ...options, graceMs: 60 });
  expect(report.commands).toBe(1);
  expect(existsSync(join(processDirectory("p", id), "stop")) || (await readProcess("p", id)).state !== "running").toBe(true);
  expect(report.problems.join(" ")).toMatch(/1 command had not stopped after the wait|^$/);
});

test("deleting an orc archives it from the bottom up: nothing is removed, lists drop it, and a restore brings back exactly what it put away", async () => {
  const tree = await ensureWorktree("p", "task/feat");
  writeFileSync(join(tree, "draft"), "only copy");
  const open = await workspaces.within("p", tree, () => registerTask("p", { name: "Open work", summary: "s", branch: "task/feat", authorized: true }));
  const [question, hidden] = await ask("p", [{ text: "Which one?" }, { text: "Already put away" }]);
  workViews.setWorkArchived("p", "questions", [hidden!.id], true);
  const folder = (await directories.directoryProjects()).find(f => f.conversations.includes("p"))!;
  let closed = "";
  const { options, log } = running(["worker-task-feat"]);
  const report = await archiveProject("p", { ...options, beforeArchive: project => { closed = project; expect(log).toContain("stop-daemon p"); } });

  expect(closed).toBe("p"); // the page closes only after everything has stopped
  expect(report.archive.tasks).toEqual([open.id]);
  expect(report.archive.questions).toEqual([question!.id]); // not the one the user had already archived
  expect(report.archive.sessions).toHaveLength(1);
  expect(describeArchive([report])).toBe("stopped 1 agent; 1 task archived");
  // Nothing left the disk: the conversation, its worktree and the file only it holds.
  expect(existsSync(paths.project("p"))).toBe(true);
  expect(existsSync(join(tree, "draft"))).toBe(true);
  expect(git(repo, "branch", "--list", "task/feat")).toContain("task/feat");
  const task = (await allTasks("p")).find(t => t.id === open.id)!;
  expect(task.removedAt).toBeTruthy(); expect(task.attention?.kind).toBe("cancelled"); // unfinished work is abandoned, its record kept
  expect(workspaces.list().find(w => w.path === tree)!.archivedAt).toBeTruthy();
  // The lists: gone from its folder's count, shown as archived inside it; its sibling is untouched.
  expect((await directories.projectRows()).find(row => row.name === folder.id)!.conversations).toEqual(["q"]);
  const rows = await directories.projectRows(folder.id);
  expect(rows.find(row => row.name === "p")!.archivedAt).toBe(report.archive.at);
  expect(rows.find(row => row.name === "q")!.archivedAt).toBeUndefined();
  expect(projectArchive("q")).toBeUndefined(); expect(execution.stopped("q")).toBe(false);
  await expect(archiveProject("p", options)).rejects.toThrow("already archived");

  await restoreProject("p");
  expect(projectArchive("p")).toBeUndefined();
  expect((await allTasks("p")).find(t => t.id === open.id)!.removedAt).toBeUndefined();
  expect(workViews.workArchive("p", "questions")).toMatchObject({ [question!.id]: false, [hidden!.id]: true }); // what the user archived stays archived
  expect(workspaces.list().find(w => w.path === tree)!.archivedAt).toBeUndefined();
  expect(execution.stopped("p")).toBe(true); // a restore starts nothing: only the user typing resumes it
  await expect(restoreProject("p")).rejects.toThrow("not archived");
});

test("deleting a bubble is deleting each of its orcs; one that cannot be checked stops nothing", async () => {
  const bubble = await ensureBubble("p", "Shared");
  await joinBubble("q", bubble.id);
  const { options, log } = running([]);
  await expect(archiveBubble(bubble.id, { ...options, live: async project => project === "q" ? null : [] })).rejects.toThrow("cannot check live agents of q; nothing was stopped");
  expect(projectArchive("p")).toBeUndefined(); expect(log).toEqual([]);
  const reports = await archiveBubble(bubble.id, options);
  expect(reports.map(report => report.project).sort()).toEqual(["p", "q"]);
  expect(projectArchive("p")).toBeTruthy(); expect(projectArchive("q")).toBeTruthy();
  expect(existsSync(join(paths.bubbles, bubble.id))).toBe(true); // nodes, pages and behavior stay with the archived orcs
  await expect(archiveBubble("missing", options)).rejects.toThrow("invalid bubble id");
});

test("orca clean is the purge: an archived orc is listed in a preview and removed, with its last bubble, when applied", async () => {
  const bubble = await ensureBubble("p", "Solo");
  const { options } = running([]);
  await archiveProject("p", options);
  const purged: string[] = [];
  const preview = await cleanStorage(false, async project => { purged.push(project); });
  expect(preview.find(change => change.path === paths.project("p"))!.disposition).toMatch(/^would remove: conversation ".*" deleted \d{4}-\d\d-\d\d$/);
  expect(purged).toEqual([]); expect(existsSync(paths.project("p"))).toBe(true);
  const { deleteProject } = await import("./ownership");
  const applied = await cleanStorage(true, project => deleteProject(project, { stop: async () => {}, live: async () => [], kill: async () => {} }));
  expect(applied.find(change => change.path === paths.project("p"))!.disposition).toStartWith("removed: conversation");
  expect(existsSync(paths.project("p"))).toBe(false);
  expect(existsSync(join(paths.bubbles, bubble.id))).toBe(false);
  expect(existsSync(paths.project("q"))).toBe(true); // a live conversation is never purged
});
