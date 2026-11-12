import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bash } from "./bash";
import { paths } from "../../../config/config";
import { OutputPreview, pruneAllOutputs, pruneOutputs } from "./output";
import { workspaces } from "../../data/projects";
let home: string;
const before = process.env.ORCA_HOME;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "tool-output-")); process.env.ORCA_HOME = home; });
afterEach(async () => { if (before === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = before; await rm(home, { recursive: true, force: true }); });
const context = () => ({ project: "test", role: "worker" as const, cwd: home });
const directory = () => join(paths.project("test"), "tool-outputs");
async function saved() { return Promise.all((await readdir(directory())).map(async name => ({ path: join(directory(), name), text: await Bun.file(join(directory(), name)).text() }))); }

test("large output is saved intact outside cwd; preview points to a private file", async () => {
  const cwd = join(home, "repo"); await Bun.$`mkdir -p ${cwd}`.quiet();
  const result = await bash.run({ command: "printf START; yes x | head -c 100000; printf END" }, { ...context(), cwd });
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(4096);
  const [file] = await saved();
  expect(file!.text.length).toBe(100008); expect(file!.text).toStartWith("START"); expect(file!.text).toEndWith("END");
  expect(result).toContain(file!.path); expect(file!.path.startsWith(cwd)).toBe(false);
  expect((await stat(file!.path)).mode & 0o777).toBe(0o600);
  expect((await stat(directory())).mode & 0o777).toBe(0o700);
});

test("normal source-sized output stays intact; explicit previews are adjustable and bounded", async () => {
  const command = "yes source | head -c 10000";
  expect(Buffer.byteLength(await bash.run({ command }, context()))).toBe(10000);
  const small = await bash.run({ command, max_output_bytes: 1024 }, context());
  expect(Buffer.byteLength(small)).toBeLessThanOrEqual(1024); expect(small).toContain("full output:");
  const larger = await bash.run({ command: "yes source | head -c 30000", max_output_bytes: 16000 }, context());
  expect(Buffer.byteLength(larger)).toBeGreaterThan(15000); expect(Buffer.byteLength(larger)).toBeLessThanOrEqual(16000);
  expect(Buffer.byteLength(await bash.run({ command, max_output_bytes: 65536 }, context()))).toBe(10000);
});

test("concurrent saves have unique paths and do not mix streams", async () => {
  await Promise.all(Array.from({ length: 8 }, (_, n) => bash.run({ command: `printf 'output-${n}'` }, context())));
  const files = await saved(); expect(files).toHaveLength(8);
  expect(new Set(files.map(f => f.text)).size).toBe(8);
  expect(new Set(files.map(f => f.path)).size).toBe(8);
});

test("output ceiling terminates command and marks partial output", async () => {
  await Bun.write(paths.config, "maxToolOutputBytes = 1024\n");
  const result = await bash.run({ command: "yes unlimited" }, context());
  expect(result).toContain("output limit reached"); expect(result).toContain("saved output is incomplete");
  const [file] = await saved(); expect(file!.path).toEndWith(".partial"); expect(Buffer.byteLength(file!.text)).toBe(1024);
});

test("storage failures and invalid previews prevent command execution", async () => {
  for (const max_output_bytes of [0, -1, 12.5, 70000, "1000"]) await expect(bash.run({ command: "touch forbidden", max_output_bytes }, context())).rejects.toThrow("max_output_bytes");
  await Bun.write(paths.project("test"), "not a directory");
  await expect(bash.run({ command: "touch forbidden" }, context())).rejects.toThrow();
  expect(await Bun.file(join(home, "forbidden")).exists()).toBe(false);
});

test("previews stay within byte limits without splitting UTF-8, including binary output", () => {
  for (const bytes of [Buffer.from("😀漢字".repeat(20000)), Buffer.alloc(10000, 255)]) {
    const preview = new OutputPreview(4096);
    for (let i = 0; i < bytes.length; i += 7) preview.add(bytes.subarray(i, i + 7));
    const result = preview.render(1024, "\n[full output: /tmp/saved.txt]");
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1024);
    expect(result.isWellFormed()).toBe(true); expect(result).toEndWith("[full output: /tmp/saved.txt]");
    if (bytes[0] !== 255) expect(result).not.toContain("�");
  }
});

test("retention evicts old completed files, preserves active output and ignores unrelated files", async () => {
  await bash.run({ command: "printf old" }, context());
  const [old] = await saved(); await utimes(old!.path, new Date(0), new Date(0));
  const active = join(directory(), `${crypto.randomUUID()}.running`); await Bun.write(active, "active");
  const unrelated = join(directory(), "notes.txt"); await Bun.write(unrelated, "leave alone");
  await pruneOutputs(directory());
  expect(await Bun.file(old!.path).exists()).toBe(false);
  expect(await Bun.file(active).text()).toBe("active"); expect(await Bun.file(unrelated).text()).toBe("leave alone");
  await bash.run({ command: "printf newest" }, context());
  await pruneOutputs(directory(), Date.now(), 1);
  expect((await readdir(directory())).filter(f => f.endsWith(".txt"))).toEqual(["notes.txt"]);
});

test("workspace-owned output remains available until explicit workspace cleanup", async () => {
  await workspaces.within("test", home, () => bash.run({ command: "printf evidence" }, context()));
  const [file] = await saved();
  expect(workspaces.resource("test", "artifact", file!.path)).toBeTruthy();
  await pruneOutputs(directory(), Date.now() + 30 * 86400_000, 1, "test");
  expect(await Bun.file(file!.path).text()).toBe("evidence");
});

const DAY = 86400_000;
async function put(path: string, text: string, ageDays = 0) {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, text);
  if (ageDays) { const at = new Date(Date.now() - ageDays * DAY); await utimes(path, at, at); }
  return path;
}
const exists = (path: string) => Bun.file(path).exists();

test("unowned harness-named outputs go by age and byte limit at any depth; other files are never removed; preview deletes nothing", async () => {
  const dir = directory(), id = () => crypto.randomUUID();
  const oldReport = await put(join(dir, "reports", `${id()}.txt`), "report", 8);
  const newReport = await put(join(dir, "reports", `${id()}.txt`), "report");
  const oldVideo = await put(join(dir, "evidence-x", "runs", "video.mp4"), "v".repeat(4096), 8);
  const newVideo = await put(join(dir, "evidence-y", "video.mp4"), "v".repeat(4096));
  const stalePartial = await put(join(dir, `${id()}.partial`), "cut", 8);
  const staleRunning = await put(join(dir, `${id()}.running`), "dead", 8);
  const liveRunning = await put(join(dir, `${id()}.running`), "live");
  const sandbox = await put(join(dir, "verification", id(), "old.log"), "sandbox evidence", 30);
  const outside = await put(join(home, "outside.txt"), "not ours", 30);
  await symlink(outside, join(dir, "link.txt")); await symlink(home, join(dir, "linked-dir"));
  const expected = [oldReport, stalePartial, staleRunning].sort();

  const preview = await pruneOutputs(dir, Date.now(), undefined, undefined, false);
  expect(preview.map(p => p.path).sort()).toEqual(expected);
  expect(preview.every(p => p.disposition.startsWith("eligible:"))).toBe(true);
  for (const path of expected) expect(await exists(path)).toBe(true);

  const removed = await pruneOutputs(dir);
  expect(removed.map(p => p.path).sort()).toEqual(expected);
  for (const path of expected) expect(await exists(path)).toBe(false);
  for (const path of [newReport, oldVideo, newVideo, liveRunning, sandbox, outside]) expect(await exists(path)).toBe(true);
  expect(await readdir(join(dir, "reports"))).toHaveLength(1);

  // The byte limit evicts harness-named files (nested too), never a folder an agent just filled.
  const over = await pruneOutputs(dir, Date.now(), 1);
  expect(over.map(p => p.path)).toEqual([newReport]);
  expect(await exists(newVideo)).toBe(true); expect(await exists(liveRunning)).toBe(true);
});

test("a registered top-level folder keeps everything under it, whatever its age or size", async () => {
  const dir = directory(), folder = join(dir, "evidence-owned");
  const video = await put(join(folder, "fix", "video.mp4"), "v".repeat(4096), 30);
  const named = await put(join(folder, `${crypto.randomUUID()}.partial`), "cut", 30);
  const loose = await put(join(dir, "evidence-loose", "video.mp4"), "v", 30);
  workspaces.within("test", home, () => workspaces.own("test", "artifact", folder, { path: folder }));
  expect(workspaces.resource("test", "artifact", folder)).toBeTruthy();
  expect((await pruneOutputs(dir, Date.now(), 1, "test")).map(p => p.path)).toEqual([]);
  expect(await exists(video)).toBe(true); expect(await exists(named)).toBe(true); expect(await exists(loose)).toBe(true);
});

test("the all-projects pass prunes an idle project, keeps registered and running outputs, and survives a project it cannot read", async () => {
  await workspaces.within("test", home, () => bash.run({ command: "printf evidence" }, context()));
  const [owned] = await saved(); await utimes(owned!.path, new Date(0), new Date(0));
  const idle = join(paths.project("idle"), "tool-outputs");
  const old = await put(join(idle, `${crypto.randomUUID()}.txt`), "old", 8);
  const nested = await put(join(idle, "evidence", "clip.mp4"), "old", 8);
  const running = await put(join(idle, `${crypto.randomUUID()}.running`), "live");
  const fresh = await put(join(idle, `${crypto.randomUUID()}.txt`), "fresh");
  await mkdir(paths.project("empty"), { recursive: true });
  await put(join(paths.project("broken"), "tool-outputs"), "not a directory");

  const preview = await pruneAllOutputs(false);
  expect(preview.filter(p => p.disposition.startsWith("eligible:")).map(p => p.path).sort()).toEqual([old]);
  expect(await exists(old)).toBe(true); expect(await exists(nested)).toBe(true);

  const rows = await pruneAllOutputs(true);
  expect(rows.filter(p => p.disposition.startsWith("removed")).map(p => p.path).sort()).toEqual([old]);
  expect(rows.filter(p => p.disposition.startsWith("kept:")).map(p => p.path)).toEqual(["broken"]);
  expect(await exists(old)).toBe(false); expect(await exists(nested)).toBe(true);
  expect(await exists(running)).toBe(true); expect(await exists(fresh)).toBe(true);
  expect(await Bun.file(owned!.path).text()).toBe("evidence");
});


test("abort preserves partial output and prevents already-cancelled commands", async () => {
  const controller = new AbortController();
  const promise = bash.run({ command: "printf started; sleep 30; touch forbidden" }, { ...context(), signal: controller.signal });
  // Wait on observable output rather than racing process startup.
  for (let n = 0; n < 200; n++) {
    const files = await readdir(directory()).catch(() => []);
    if (files.length && (await Bun.file(join(directory(), files[0]!)).text()) === "started") break;
    await Bun.sleep(5);
  }
  controller.abort(new Error("cancelled by test"));
  await expect(promise).rejects.toThrow("cancelled by test");
  const files = await saved();
  expect(files).toHaveLength(1); expect(files[0]!.path).toEndWith(".partial"); expect(files[0]!.text).toBe("started");
  await expect(bash.run({ command: "touch forbidden" }, { ...context(), signal: controller.signal })).rejects.toThrow("cancelled by test");
  expect(await Bun.file(join(home, "forbidden")).exists()).toBe(false);
});
