import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bash } from "./tools/bash";
import { paths } from "./config";
import { OutputPreview, pruneOutputs } from "./tool-output";
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
