import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationIdentity, paths, repositoryBinding, writeProjectState } from "../../../config";
import { canonicalTask, type Task } from "../../../protocol/task";
import { installTaskLedgerSchema } from "../sqlite/task-ledger";
import { existingLedgerTasks } from "./ledger-store";
import { allTasks, listTasks, registerTask } from "./tasks";
import { directories } from "../projects";
let root: string, previous: string | undefined, directory: string, original: Task, savedBinding: string;
const project = "legacy";
let repo: NonNullable<ReturnType<typeof repositoryBinding>>;
beforeEach(() => {
  previous = process.env.ORCA_HOME; root = mkdtempSync(join(tmpdir(), "orca-ledger-binding-")); process.env.ORCA_HOME = join(root, "home");
  mkdirSync(paths.project(project), { recursive: true }); directory = join(root, "repo"); mkdirSync(directory); directory = realpathSync(directory);
  repo = { version: 1, directory, branch: "main", worktreeId: crypto.randomUUID() }; writeProjectState(project, "repository", repo);
  const identity = conversationIdentity(paths.root, project);
  savedBinding = JSON.stringify({ identity: `999:${identity.fingerprint}`, repository: repo });
  original = { id: crypto.randomUUID(), number: 1, name: "Keep this task", summary: "Original evidence", branch: "feat/task", status: "queued", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", revision: 1, runs: [], history: [{ revision: 1, at: "2026-01-01T00:00:00Z", kind: "registered", status: "queued" }] };
  const db = new Database(paths.memory); installTaskLedgerSchema(db);
  db.query("INSERT INTO task_ledger_projects(project_id,repository) VALUES(?,?)").run(project, savedBinding);
  db.query("INSERT INTO task_ledger_records VALUES(?,?,?,?,?,?,?,?,NULL)").run(original.id, project, 1, original.id, JSON.stringify(canonicalTask(original)), JSON.stringify({ legacy: original }), 1, 1);
  db.close();
});
afterEach(() => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; rmSync(root, { recursive: true, force: true }); });
const snapshot = () => {
  const db = new Database(paths.memory, { readonly: true });
  try { return { binding: db.query("SELECT repository,high_water FROM task_ledger_projects WHERE project_id=?").get(project), rows: db.query("SELECT * FROM task_ledger_records WHERE project_id=? ORDER BY number").all(project) }; }
  finally { db.close(); }
};
test("legacy identity reads through both production task APIs without rewriting binding, tasks or projection", async () => {
  const before = snapshot();
  expect(existingLedgerTasks(project)?.map(t => t.id)).toEqual([original.id]);
  expect((await allTasks(project)).map(t => t.id)).toEqual([original.id]);
  expect((await listTasks(project)).map(t => t.number)).toEqual([1]);
  expect(snapshot()).toEqual(before); expect(existsSync(join(paths.project(project), "tasks.json"))).toBe(false);
});
test("writes retain original identity and task numbers while monotonically allocating new numbers", async () => {
  const added = await registerTask(project, { name: "Second task", summary: "New work", branch: "feat/second", authorized: true });
  expect(added.number).toBe(2); expect((await allTasks(project)).map(t => t.id)).toEqual([original.id, added.id]);
  expect(snapshot().binding).toEqual({ repository: savedBinding, high_water: 2 });
  const projection = JSON.parse(readFileSync(join(paths.project(project), "tasks.json"), "utf8"));
  expect(projection.tasks.map((t: { number: number }) => t.number)).toEqual([1, 2]);
});
for (const field of ["directory", "branch", "worktreeId"] as const) test(`an unapproved ${field} change still refuses ledger adoption`, async () => {
  const before = snapshot();
  writeProjectState(project, "repository", { ...repo, [field]: field === "directory" ? join(root, "foreign") : field === "worktreeId" ? crypto.randomUUID() : "other" });
  expect(() => existingLedgerTasks(project)).toThrow("identity/repository changed");
  await expect(allTasks(project)).rejects.toThrow("identity/repository changed"); expect(snapshot()).toEqual(before);
});
test("recreating the same storage name cannot adopt the old task ledger", async () => {
  rmSync(paths.project(project), { recursive: true }); mkdirSync(paths.project(project)); writeProjectState(project, "repository", repo);
  await expect(allTasks(project)).rejects.toThrow("identity/repository changed");
});
test("explicit validated directory relink retains ledger access without mutating the binding", async () => {
  expect(Bun.spawnSync(["git", "init", "-q", "-b", "main", directory]).exitCode).toBe(0);
  const parent = directories.attachConversation(project)!;
  const moved = join(root, "moved"); renameSync(directory, moved);
  await directories.relinkDirectoryProject(parent.id, moved);
  expect((await allTasks(project)).map(t => t.id)).toEqual([original.id]);
  expect(snapshot().binding).toEqual({ repository: savedBinding, high_water: 1 });
});
