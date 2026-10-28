import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertLayout, paths, saveConfig, repositoryBinding, writeProjectState } from "./index";
import { initializeWorkspace } from "../core/data/projects/workspace";
import { setDisplayName, displayName, listProjects } from "../core/data/projects/registry";
import { saveProjectModel, effectiveModel } from "../core/data/projects/project-model";
import { saveProjectFlow, effectiveFlow } from "../core/data/projects/flow";
import { remember, facts, updateContext, workingContext, clearWorkingContext } from "../core/data/knowledge";
import { open } from "../core/data/transcripts";
import { editableTool } from "../core/definitions";
import { read } from "../core/tools/files";
import { rolePrompt } from "../core/prompt";
import { defaults } from "./config";
import { message } from "../core/tools/message";
import { outputArtifact } from "../core/tools/bash/output";
import { claudeCredentialsPath } from "../login/claude";
import { withCredentialLock, writeTokens } from "../login/oauth";
let suite: string, previous: string | undefined, repo: string;
beforeEach(async () => {
  previous = process.env.ORCA_HOME; suite = mkdtempSync(join(tmpdir(), "orca-home-structure-"));
  process.env.ORCA_HOME = join(suite, "state"); repo = join(suite, "repo"); mkdirSync(repo);
  const git = Bun.spawn(["git", "init", "-b", "main", repo], { stdout: "ignore", stderr: "ignore" }); expect(await git.exited).toBe(0);
  assertLayout(paths.root); await initializeWorkspace("p", repo);
});
afterEach(() => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; rmSync(suite, { recursive: true, force: true }); });

test("normal features stay inside the agreed public home/project categories", async () => {
  await saveConfig({ model: "gpt-6-astra" }); await setDisplayName("p", "Example");
  await saveProjectModel("p", "gpt-6-astra"); await saveProjectFlow("p", { dynamicDispatch: true });
  await remember("p", "user", { key: "tone", text: "concise", source: "human-1", confidence: "explicit", updatedAt: "now", project: "p" });
  await updateContext("p", { goal: "Build the requested result", decisions: ["Keep changes local"] });
  editableTool(read); rolePrompt("orchestrator", defaults);
  const credential = claudeCredentialsPath("fixture");
  await withCredentialLock(credential, () => writeTokens(credential, { accessToken: "fake-local-fixture" }));
  await open(paths.transcript("p", "orchestrator")).append({ type: "message", message: { role: "user", content: "original request" } });
  const artifact = await outputArtifact("p"); await artifact.write(Buffer.from("command evidence")); await artifact.finish(true);
  await message.run({ to: "orchestrator", text: "detailed evidence", summary: "result" }, { project: "p", role: "worker", branch: "work", cwd: repo });
  mkdirSync(join(paths.project("p"), "images"));
  expect(readdirSync(paths.root).filter(n => !["memory.sqlite-wal", "memory.sqlite-shm"].includes(n)).sort()).toEqual([".runtime", "memory.sqlite", "projects", "prompts", "skills", "tools"]);
  // tasks.json appears only when publication work is registered.
  expect(readdirSync(paths.project("p")).sort()).toEqual(["cache", "images", "tool-outputs", "transcript"]);
  expect(credential).toContain("/.runtime/auth/");
  expect(readdirSync(join(paths.project("p"), "tool-outputs", "reports"))).toHaveLength(1);
});

test("clearing cache preserves settings, bindings, decisions and original evidence across restart", async () => {
  await setDisplayName("p", "Example"); await saveProjectModel("p", "gpt-6-astra"); await saveProjectFlow("p", { maxReviewRounds: 3 });
  await updateContext("p", { goal: "Keep this goal", decisions: ["Keep this decision"] });
  await remember("p", "project", { key: "domain", text: "project fact", source: "human-1", confidence: "explicit", updatedAt: "now", project: "p" });
  const transcript = open(paths.transcript("p", "orchestrator"));
  await transcript.append({ type: "message", message: { role: "user", content: "durable source" } });
  const before = readFileSync(transcript.path, "utf8");
  writeFileSync(join(paths.cache("p"), "derived.txt"), "rebuildable"); rmSync(paths.cache("p"), { recursive: true });
  expect(repositoryBinding("p")?.directory).toBe(realpathSync(repo)); expect(await listProjects()).toEqual(["p"]);
  expect(await displayName("p")).toBe("Example"); expect(await effectiveModel("p")).toBe("gpt-6-astra"); expect((await effectiveFlow("p")).maxReviewRounds).toBe(3);
  expect((await workingContext("p")).goal).toBe("Keep this goal"); expect(await facts("p", "project")).toHaveLength(1);
  expect(readFileSync(transcript.path, "utf8")).toBe(before);
  const code = `import { paths, readProjectState } from ${JSON.stringify(import.meta.dir + "/index.ts")}; console.log(JSON.stringify(readProjectState('p','working-context')));`;
  const child = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, ORCA_HOME: paths.root }, stdout: "pipe", stderr: "pipe" });
  const [exit, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(exit).toBe(0); expect(JSON.parse(out)).toEqual({ goal: "Keep this goal", decisions: ["Keep this decision"] });
});

test("old layout refuses startup without migrating or deleting existing data", () => {
  const old = join(suite, "old-home"); mkdirSync(join(old, ".runtime"), { recursive: true });
  writeFileSync(join(old, ".runtime/layout.json"), '{"version":2}\n'); writeFileSync(join(old, "config.toml"), "old settings");
  expect(() => assertLayout(old)).toThrow("fresh home"); expect(readFileSync(join(old, "config.toml"), "utf8")).toBe("old settings");
  expect(readFileSync(join(old, ".runtime/layout.json"), "utf8")).toBe('{"version":2}\n');
});

// The rollback awaits transcript publication; a recreated name has a new identity.
test("a delayed clear rollback cannot restore old decisions into a replacement project", async () => {
  await updateContext("p", { goal: "old goal" });
  await expect(clearWorkingContext("p", async () => {
    rmSync(paths.project("p"), { recursive: true });
    await initializeWorkspace("p", repo);
    writeProjectState("p", "working-context", { goal: "replacement goal" });
    throw new Error("boundary failed");
  })).rejects.toThrow("boundary failed");
  expect(await workingContext("p")).toEqual({ goal: "replacement goal" });
});
