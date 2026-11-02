import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertLayout, conversationIds, conversationIdentity, paths, readProjectState, repositoryBinding, updateState, writeProjectState } from "../config";
import { initializeWorkspace } from "../core/data/projects/workspace";
import { listProjects, setDisplayName } from "../core/data/projects/registry";
import { renameDirectoryProject, parentProject } from "../core/data/projects/catalog";
import { projectIdentity } from "../core/data/projects/state";
import { registerTask, allTasks } from "../core/data/tasks/tasks";
import { open } from "../core/data/transcripts/transcript";
import { blockRef, imageBlock, loadImage, materializeImages, saveImage } from "../core/data/images/images";
import { deleteProject, restoreConversations } from "../tui/commands/project";
import { png } from "../test/image-fixture";
import { organizeProjects, orcaParticipantIds } from "./organize";

let root: string, previous: string | undefined, checkout: string;
beforeEach(() => {
  previous = process.env.ORCA_HOME; root = mkdtempSync(join(tmpdir(), "orca-organize-"));
  process.env.ORCA_HOME = join(root, "home"); checkout = join(root, "phoebe"); mkdirSync(checkout);
  checkout = realpathSync(checkout);
  assertLayout(paths.root);
});
afterEach(() => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; rmSync(root, { recursive: true, force: true }); });
function legacy(id: string, name = "phoebe-agent-notes") {
  mkdirSync(join(paths.projects, id), { recursive: true });
  writeProjectState(id, "repository", { version: 1, directory: checkout, branch: "main", worktreeId: crypto.randomUUID() });
  writeProjectState(id, "name", name);
}
const visible = () => readdirSync(paths.projects).filter(n => !n.startsWith("."));
const group = () => join(paths.projects, visible()[0]!);
const links = () => join(group(), "conversations");
test("host inventory recognizes actual binaries and scripts, excluding the organizer and shell/SSH parents", () => {
  expect(orcaParticipantIds([
    "1 /Users/example/.local/bin/orca agent --project one",
    "2 bun src/cli/main.ts start",
    "3 /usr/local/bin/bun /checkout/src/cli/main.ts agent",
    "4 /bin/zsh -c orca organize",
    "5 ssh server orca organize",
    "6 orca organize",
    "7 bun run src/cli/main.ts",
  ].join("\n"), 6)).toEqual(["Orca process 1", "Orca process 2", "Orca process 3", "Orca process 7"]);
});
function taskRows() {
  const db = new Database(paths.memory, { readonly: true });
  try { return JSON.stringify([db.query("SELECT * FROM task_ledger_projects ORDER BY project_id").all(), db.query("SELECT * FROM task_ledger_records ORDER BY project_id,number").all()]); }
  finally { db.close(); }
}

test("offline move preserves UUIDs, task SQL, settings, transcript/image bytes and duplicate renamed conversations", async () => {
  legacy("orch-369l"); legacy("orch-5xab");
  const identity = projectIdentity("orch-5xab"), originalBinding = repositoryBinding("orch-5xab");
  const ref = await saveImage("orch-5xab", png());
  const transcript = open(paths.transcript("orch-5xab", "orchestrator"));
  await transcript.append({ type: "message", message: { role: "user", content: [imageBlock(ref)] } });
  const original = readFileSync(transcript.path);
  const task = await registerTask("orch-5xab", { name: "Retain task", summary: "original", branch: "feat/retained", authorized: true });
  writeProjectState("orch-5xab", "account", { provider: "openai", profile: "phoebe" });
  const before = taskRows();
  expect(await organizeProjects(async () => [])).toBe(2);
  expect(visible()).toHaveLength(1);
  expect(visible()[0]).toMatch(/^phoebe--[a-f0-9]{8}$/);
  expect(readdirSync(links()).sort()).toEqual(["phoebe-agent-notes--369l", "phoebe-agent-notes--5xab"]);
  expect(readlinkSync(join(links(), "phoebe-agent-notes--5xab"))).toBe("../../.conversations/orch-5xab");
  expect(projectIdentity("orch-5xab")).toBe(identity);
  expect(repositoryBinding("orch-5xab")).toEqual(originalBinding);
  expect(readProjectState("orch-5xab", "account")).toEqual({ provider: "openai", profile: "phoebe" });
  expect(readFileSync(paths.transcript("orch-5xab", "orchestrator"))).toEqual(original);
  expect(await loadImage("orch-5xab", ref)).toEqual(png());
  expect((await allTasks("orch-5xab")).map(t => t.id)).toEqual([task.id]);
  expect(taskRows()).toBe(before);
  expect(await listProjects()).toEqual(["orch-369l", "orch-5xab"]);
  assertLayout(paths.root);
  const opened: string[] = [];
  await restoreConversations({ source: checkout, open: async id => { opened.push(id); }, note() {} });
  expect(new Set(opened)).toEqual(new Set(["orch-369l", "orch-5xab"]));
});

test("renaming conversation and directory links keeps an already-open transcript writable", async () => {
  legacy("orch-5xab"); await organizeProjects(async () => []);
  const transcript = open(paths.transcript("orch-5xab", "orchestrator"));
  const stable = transcript.path, identity = projectIdentity("orch-5xab");
  await transcript.append({ type: "message", message: { role: "user", content: "before" } });
  await setDisplayName("orch-5xab", "New title");
  expect(readdirSync(links())).toEqual(["New-title--5xab"]);
  await renameDirectoryProject(parentProject("orch-5xab")!.id, "My checkout");
  expect(visible()[0]).toMatch(/^My-checkout--/);
  await transcript.append({ type: "message", message: { role: "assistant", content: "after" } });
  expect(paths.transcript("orch-5xab", "orchestrator")).toBe(stable);
  expect(projectIdentity("orch-5xab")).toBe(identity);
  expect(readFileSync(join(links(), "New-title--5xab", "transcript", "orchestrator.jsonl"), "utf8")).toContain("after");
});

test("different checkouts with the same basename remain distinct groups across a fresh process", async () => {
  legacy("one"); legacy("two");
  const other = join(root, "other", "phoebe"); mkdirSync(other, { recursive: true });
  writeProjectState("two", "repository", { version: 1, directory: realpathSync(other), branch: "main", worktreeId: crypto.randomUUID() });
  await organizeProjects(async () => []);
  expect(visible()).toHaveLength(2);
  expect(visible().every(name => /^phoebe--/.test(name))).toBe(true);
  const module = join(import.meta.dir, "../core/data/projects/registry.ts");
  const child = Bun.spawn([process.execPath, "-e", `import {listProjects} from ${JSON.stringify(module)}; console.log(JSON.stringify(await listProjects()))`], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(err).toBe(""); expect(code).toBe(0); expect(JSON.parse(out)).toEqual(["one", "two"]);
});

test("active host participants refuse before touching artifact folders", async () => {
  legacy("orch-5xab"); const path = paths.project("orch-5xab"), identity = readFileSync(join(path, ".identity.json"));
  await expect(organizeProjects(async () => ["running worker", "open TUI"])).rejects.toThrow("Nothing was moved");
  expect(paths.project("orch-5xab")).toBe(path);
  expect(readFileSync(join(path, ".identity.json"))).toEqual(identity);
  expect(existsSync(join(paths.projects, ".conversations"))).toBe(false);
});

test("unknown or active durable locks refuse even if host inventory appears empty", async () => {
  legacy("orch-5xab");
  mkdirSync(join(paths.runtime, "daemon-locks", "orch-5xab"), { recursive: true });
  await expect(organizeProjects(async () => [])).rejects.toThrow("still has a participant");
  expect(visible()).toEqual(["orch-5xab"]);
});

test("unresolved supervised commands refuse before moving any conversation", async () => {
  legacy("orch-369l"); legacy("orch-5xab");
  const id = crypto.randomUUID(), dir = join(paths.runtimeProject("orch-5xab"), "processes", id);
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "state.json"), JSON.stringify({ id, project: "orch-5xab", state: "unknown" }));
  await expect(organizeProjects(async () => [])).rejects.toThrow("unresolved background process");
  expect(visible().sort()).toEqual(["orch-369l", "orch-5xab"]);
});

test("migration guard fences concurrent launches; interrupted guard requires explicit recovery", async () => {
  legacy("orch-5xab");
  const dir = join(paths.runtime, "storage-organization"); mkdirSync(dir);
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: 999999999, since: "old" }));
  expect(() => paths.project("orch-5xab")).toThrow("organization is in progress");
  expect(() => assertLayout(paths.root)).toThrow("organization is in progress");
  expect(await organizeProjects(async () => [])).toBe(1);
  assertLayout(paths.root);
});

test("partially moved homes resume without duplicate IDs or lost artifacts", async () => {
  legacy("orch-369l"); legacy("orch-5xab");
  const identity = conversationIdentity(paths.root, "orch-369l");
  mkdirSync(join(paths.projects, ".conversations"));
  renameSync(join(paths.projects, "orch-369l"), join(paths.projects, ".conversations", "orch-369l"));
  expect(await organizeProjects(async () => [])).toBe(1);
  expect(conversationIds(paths.root)).toEqual(["orch-369l", "orch-5xab"]);
  expect(conversationIdentity(paths.root, "orch-369l")).toEqual(identity);
  expect(await organizeProjects(async () => [])).toBe(0);
});

test("fresh workspaces use grouped names immediately and deletion removes only that conversation", async () => {
  const git = Bun.spawn(["git", "init", "-b", "main", checkout], { stdout: "ignore", stderr: "ignore" }); expect(await git.exited).toBe(0);
  await initializeWorkspace("one", checkout); await initializeWorkspace("two", checkout);
  await setDisplayName("one", "Notes");
  expect(visible()).toHaveLength(1);
  expect(readdirSync(links())).toContain("Notes--one");
  await deleteProject("one", { live: async () => [], stop: async () => {}, kill: async () => {} });
  expect(await listProjects()).toEqual(["two"]);
  expect(readdirSync(links())).toEqual(["two--two"]);
  expect(existsSync(checkout)).toBe(true);
});

test("unbound retained artifacts and their immutable legacy ledger fallback remain recoverable", async () => {
  mkdirSync(join(paths.projects, "orphan"), { recursive: true });
  const task = await registerTask("orphan", { name: "Retain", summary: "unbound", branch: "feat/orphan", authorized: true });
  expect(await organizeProjects(async () => [])).toBe(1);
  expect(visible()).toEqual(["Unassigned--unassigned"]);
  expect((await allTasks("orphan")).map(t => t.id)).toEqual([task.id]);
});

test("legacy Git workspaces refuse relocation rather than break Git paths", async () => {
  legacy("orch-5xab"); mkdirSync(join(paths.project("orch-5xab"), "worktrees"));
  await expect(organizeProjects(async () => [])).rejects.toThrow("legacy in-folder Git workspaces");
  expect(visible()).toEqual(["orch-5xab"]);
});

test("unsafe links and duplicate storage are rejected without following outside the home", async () => {
  legacy("orch-5xab"); await organizeProjects(async () => []);
  symlinkSync(checkout, join(links(), "outside"));
  // Readable links cannot redirect runtime discovery or execution authority.
  expect(await listProjects()).toEqual(["orch-5xab"]);
  expect(() => assertLayout(paths.root)).toThrow("unsafe conversation link");
  rmSync(join(links(), "outside"));
  mkdirSync(join(paths.projects, "orch-5xab"));
  expect(() => paths.project("orch-5xab")).toThrow("duplicate conversation storage");
  expect(() => conversationIds(paths.root)).toThrow("duplicate conversation storage");
});

test("Finder metadata and user-added view files survive renames", async () => {
  legacy("orch-5xab"); await organizeProjects(async () => []);
  const old = group(); writeFileSync(join(old, "keep.txt"), "keep me", { mode: 0o600 });
  writeFileSync(join(links(), ".DS_Store"), "metadata", { mode: 0o600 });
  writeFileSync(join(links(), "note.txt"), "keep too", { mode: 0o600 });
  await renameDirectoryProject(parentProject("orch-5xab")!.id, "Renamed");
  expect(readFileSync(join(old, "keep.txt"), "utf8")).toBe("keep me");
  expect(readFileSync(join(old, "conversations", "note.txt"), "utf8")).toBe("keep too");
  assertLayout(paths.root);
});

test("retained image scope remains valid after organization and a later rename", async () => {
  legacy("orch-5xab");
  const { fingerprint } = conversationIdentity(paths.root, "orch-5xab");
  updateState(paths.memory, `project:orch-5xab:42:${fingerprint}`, "old", () => true);
  const saved = await saveImage("orch-5xab", png());
  const crypto = await import("node:crypto");
  const image = { ...saved, scope: crypto.createHash("sha256").update(`orch-5xab\0${42}:${fingerprint}`).digest("hex") };
  const block = imageBlock(image);
  await organizeProjects(async () => []); await setDisplayName("orch-5xab", "New name");
  const delivered = await materializeImages("orch-5xab", [{ role: "user", content: [block] }]);
  expect(JSON.stringify(delivered)).toContain(png().toString("base64"));
  expect(blockRef(block)).toEqual(image);
});
