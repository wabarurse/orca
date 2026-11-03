import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths, projectStateScope, readProjectState, repositoryBinding, updateState, writeProjectState } from "../../../config";
import { attachConversation, directoryProjects, inheritDefaults, parentProject, promoteDefaults, projectRows, relinkDirectoryProject, rememberConversations, selectStartupConversations } from "./catalog";
import { effectiveModel } from "./project-model";
import { matchesProjectIdentity, projectIdentity } from "./state";
import { listProjects } from "./registry";
import { restoreConversations } from "../../../tui/commands/project";
let root: string, directory: string, previous: string | undefined;
beforeEach(() => { previous = process.env.ORCA_HOME; root = mkdtempSync(join(tmpdir(), "orca-directory-projects-")); process.env.ORCA_HOME = join(root, "home"); directory = join(root, "checkout"); mkdirSync(directory); });
afterEach(() => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; rmSync(root, { recursive: true, force: true }); });
function conversation(id: string) {
  mkdirSync(paths.project(id), { recursive: true });
  writeProjectState(id, "repository", { version: 1, directory, branch: "main", worktreeId: crypto.randomUUID() });
}
test("device renumbering recovers legacy bindings and settings without changing history IDs", async () => {
  mkdirSync(paths.project("old"), { recursive: true });
  const st = statSync(paths.project("old"), { bigint: true });
  const old = `project:old:999:${st.ino}:${st.birthtimeNs}`;
  updateState(paths.memory, old, "repository", () => ({ version: 1, directory, branch: "main", worktreeId: crypto.randomUUID() }));
  updateState(paths.memory, old, "name", () => "phoebe-agent-notes");
  updateState(paths.memory, old, "model", () => "gpt-6-astra");
  expect(await listProjects()).toEqual(["old"]);
  expect(await effectiveModel("old")).toBe("gpt-6-astra");
  expect(readProjectState("old", "name")).toBe("phoebe-agent-notes");
  expect(projectStateScope("old")).toMatch(/^conversation:[a-f0-9-]{36}$/);
  expect(matchesProjectIdentity("old", `999:${st.ino}:${st.birthtimeNs}`)).toBe(true);
  expect(repositoryBinding("old")?.directory).toBe(directory);
});
test("ambiguous legacy settings fail closed rather than select another account", () => {
  mkdirSync(paths.project("ambiguous"), { recursive: true }); const st = statSync(paths.project("ambiguous"), { bigint: true });
  for (const [dev, profile] of [[100, "work"], [101, "personal"]]) updateState(paths.memory, `project:ambiguous:${dev}:${st.ino}:${st.birthtimeNs}`, "account", () => ({ provider: "openai", profile }));
  expect(() => readProjectState("ambiguous", "account")).toThrow("conflicting legacy project state");
});
test("directory projects group separate conversations and preserve conversation overrides", async () => {
  conversation("one"); writeProjectState("one", "model", "gpt-6-astra");
  const parent = attachConversation("one")!;
  conversation("two"); const other = attachConversation("two")!;
  expect(other.id).toBe(parent.id); expect((await directoryProjects())).toHaveLength(1);
  expect(await effectiveModel("two")).toBe("gpt-6-astra");
  writeProjectState("two", "model", "gpt-6-sol"); expect(await effectiveModel("one")).toBe("gpt-6-astra");
  promoteDefaults("two"); conversation("three"); attachConversation("three");
  expect(await effectiveModel("three")).toBe("gpt-6-sol");
  inheritDefaults("one"); expect(await effectiveModel("one")).toBe("gpt-6-sol");
  expect(parentProject("three")?.id).toBe(parent.id);
});
test("recreating a conversation never inherits settings or its persisted UUID", () => {
  conversation("replace"); writeProjectState("replace", "name", "old identity"); writeProjectState("replace", "model", "gpt-6-astra"); attachConversation("replace"); const prior = projectIdentity("replace");
  rmSync(paths.project("replace"), { recursive: true }); mkdirSync(paths.project("replace"));
  expect(projectIdentity("replace")).not.toBe(prior); expect(readProjectState("replace", "name")).toBeUndefined(); expect(readProjectState("replace", "model")).toBeUndefined(); expect(parentProject("replace")).toBeUndefined();
});
test("startup restores only remembered conversations and never creates or runs work", async () => {
  conversation("one"); conversation("two"); conversation("closed");
  rememberConversations(["one", "two"], "two"); const opened: string[] = [], notes: string[] = [];
  await restoreConversations({ open: async id => { opened.push(id); }, note: text => notes.push(text) });
  expect(opened).toEqual(["one", "two", "two"]); expect(notes).toEqual([]);
  rememberConversations([], undefined); opened.length = 0;
  await restoreConversations({ open: async id => { opened.push(id); }, note() {} }); expect(opened).toEqual([]);
});

test("persisted conversation UUID travels with a moved or restored folder", () => {
  conversation("portable"); writeProjectState("portable", "model", "gpt-6-astra"); const original = projectIdentity("portable");
  cpSync(paths.project("portable"), join(root, "saved-folder"), { recursive: true });
  rmSync(paths.project("portable"), { recursive: true }); cpSync(join(root, "saved-folder"), paths.project("portable"), { recursive: true });
  expect(projectIdentity("portable")).toBe(original); expect(readProjectState("portable", "model")).toBe("gpt-6-astra");
});

test("late legacy writes remain visible until an explicit override; cleared settings do not reappear", () => {
  mkdirSync(paths.project("handoff"), { recursive: true }); const st = statSync(paths.project("handoff"), { bigint: true });
  const old = `project:handoff:111:${st.ino}:${st.birthtimeNs}`;
  updateState(paths.memory, old, "model", () => "gpt-6-astra");
  expect(readProjectState("handoff", "model")).toBe("gpt-6-astra");
  updateState(paths.memory, old, "model", () => "gpt-6-sol");
  expect(readProjectState("handoff", "model")).toBe("gpt-6-sol");
  writeProjectState("handoff", "model", "selected-model");
  updateState(paths.memory, old, "model", () => "stale-model");
  expect(readProjectState("handoff", "model")).toBe("selected-model");
  writeProjectState("handoff", "model", undefined);
  expect(readProjectState("handoff", "model")).toBeUndefined();
});

test("missing directories stay discoverable; validated relink preserves IDs, defaults and artifacts", async () => {
  expect(Bun.spawnSync(["git", "init", "-q", "-b", "main", directory]).exitCode).toBe(0);
  conversation("moving"); writeProjectState("moving", "model", "gpt-6-astra"); const project = attachConversation("moving")!;
  writeFileSync(join(paths.project("moving"), "evidence.txt"), "preserved");
  const moved = join(root, "moved"); renameSync(directory, moved);
  expect((await projectRows()).find(p => p.name === project.id)?.label).toContain("directory missing");
  expect(await relinkDirectoryProject(project.id, moved)).toBe(realpathSync(moved));
  expect(parentProject("moving")?.id).toBe(project.id); expect(repositoryBinding("moving")?.directory).toBe(realpathSync(moved));
  expect(readProjectState("moving", "model")).toBe("gpt-6-astra");
  expect(readFileSync(join(paths.project("moving"), "evidence.txt"), "utf8")).toBe("preserved");
  await expect(relinkDirectoryProject(project.id, join(root, "absent"))).rejects.toThrow();
  expect(parentProject("moving")?.directory).toBe(realpathSync(moved));
});
test("startup name selection retains both duplicate names without deleting other history", async () => {
  for (const id of ["one", "two", "other"]) conversation(id);
  for (const id of ["one", "two"]) writeProjectState(id, "name", "same-title");
  expect(await selectStartupConversations("same-title")).toEqual(["one", "two"]);
  const opened: string[] = [];
  await restoreConversations({ open: async id => { opened.push(id); }, note() {} });
  expect([...new Set(opened)]).toEqual(["one", "two"]);
  expect(await listProjects()).toContain("other");
});

test("starting inside a directory opens its conversations without startup configuration", async () => {
  expect(Bun.spawnSync(["git", "init", "-q", "-b", "main", directory]).exitCode).toBe(0);
  conversation("one"); conversation("two");
  const elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere);
  conversation("other"); writeProjectState("other", "repository", { version: 1, directory: elsewhere, branch: "main", worktreeId: crypto.randomUUID() });
  const nested = join(directory, "nested"); mkdirSync(nested);
  for (const open of [[], ["other"]]) {
    rememberConversations(open, open[0]); const opened: string[] = [], notes: string[] = [];
    await restoreConversations({ source: nested, open: async id => { opened.push(id); }, note: text => notes.push(text) });
    expect([...new Set(opened)]).toEqual(["one", "two"]);
    expect(notes).toEqual([]);
  }
});

test("a new checkout opens no unrelated conversations regardless of saved startup views", async () => {
  conversation("raven");
  const source = join(root, "ide");
  expect(Bun.spawnSync(["git", "init", "-q", "-b", "main", source]).exitCode).toBe(0);
  const nested = join(source, "nested"); mkdirSync(nested);
  for (const saved of [undefined, [], ["raven"]]) {
    if (saved) rememberConversations(saved, saved[0]);
    const opened: string[] = [], notes: string[] = [];
    await restoreConversations({ source: nested, open: async id => { opened.push(id); }, note: text => notes.push(text) });
    expect(opened).toEqual([]);
    expect(notes).toEqual([`new directory: /new <conversation name> ${nested} to add it as a project`]);
    expect(await listProjects()).toEqual(["raven"]);
  }
  // An explicit conversation argument still overrides directory-based startup.
  const opened: string[] = [];
  await restoreConversations({ project: "raven", source, open: async id => { opened.push(id); }, note() {} });
  expect(opened).toEqual(["raven"]);
});
