import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLayout, paths } from "../../config";
import { edit, editPreview, mutate, read } from "./files";
import type { ToolContext } from "./registry";

let home: string, cwd: string, ctx: ToolContext, previous: string | undefined;
beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  home = await mkdtemp(join(tmpdir(), "orca-files-")); process.env.ORCA_HOME = home;
  assertLayout(home);
  cwd = join(home, "workspace"); await mkdir(cwd); await mkdir(paths.project("test"), { recursive: true });
  ctx = { project: "test", role: "worker", branch: "work", cwd, run: crypto.randomUUID() };
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  await rm(home, { recursive: true, force: true });
});
const file = (name: string) => join(cwd, name);
const text = (name: string) => readFile(file(name), "utf8");
const failure = (input: Record<string, unknown>) => edit.run(input, ctx).then(() => "", (e: Error) => e.message);

test("edit needs no read or revision and returns a numbered preview with both revisions", async () => {
  await writeFile(file("a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n", { mode: 0o640 });
  const before = JSON.parse(await read.run({ path: "a.ts" }, ctx) as string).revision;
  const result = JSON.parse(await edit.run({ path: "a.ts", old_text: "b = 2", new_text: "b = 20" }, ctx));
  expect(await text("a.ts")).toBe("const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n");
  expect(result.preview).toBe("1: const a = 1;\n2: const b = 20;\n3: const c = 3;");
  expect(result.previous_revision).toBe(before);
  expect(result.revision).toBe(JSON.parse(await read.run({ path: "a.ts" }, ctx) as string).revision);
  expect(result.bytes).toBe(Buffer.byteLength(await text("a.ts")));
  expect(result).not.toHaveProperty("replacements");
  expect((await Bun.file(file("a.ts")).stat()).mode & 0o777).toBe(0o640);
  expect(edit.spec.input_schema.required).toEqual(["path", "old_text", "new_text"]);
  expect(edit.spec.description).toContain("no prior read");
});

test("a supplied expected_revision is still enforced: current passes, stale or malformed is refused", async () => {
  await writeFile(file("a.txt"), "one\ntwo\n");
  const first = JSON.parse(await read.run({ path: "a.txt" }, ctx) as string).revision;
  const done = JSON.parse(await edit.run({ path: "a.txt", expected_revision: first, old_text: "two", new_text: "three" }, ctx));
  const stale = await failure({ path: "a.txt", expected_revision: first, old_text: "one", new_text: "lost" });
  expect(stale).toContain("file changed");
  expect(stale).toContain(done.revision);
  expect(await failure({ path: "a.txt", expected_revision: null, old_text: "one", new_text: "lost" })).toContain("expected_revision must be a string");
  expect(await text("a.txt")).toBe("one\nthree\n");
});

test("zero and multiple matches change nothing and say where to look", async () => {
  const original = "function a() {\n    return 1;\n}\nfunction b() {\n    return 1;\n}\nx\n    return 1;\n";
  await writeFile(file("a.ts"), original);
  const none = await failure({ path: "a.ts", old_text: "  return 1;\n}\nfunction c", new_text: "x" });
  expect(none).toContain("old_text not found (0 matches)");
  expect(none).toContain("at line 2, 5, 8");
  expect(none).toContain(JSON.stringify("    return 1;"));
  expect(await failure({ path: "a.ts", old_text: "nowhere", new_text: "x" })).toBe("old_text not found (0 matches); nothing was changed. It must match the file exactly, including whitespace and indentation.");
  const many = await failure({ path: "a.ts", old_text: "return 1;", new_text: "return 2;" });
  expect(many).toContain("old_text matches 3 locations (lines 2, 5, 8)");
  expect(many).toContain("replace_all");
  expect(await failure({ path: "overlap.txt", old_text: "x", new_text: "y" })).toContain("ENOENT");
  await writeFile(file("overlap.txt"), "aaa\n");
  expect(await failure({ path: "overlap.txt", old_text: "aa", new_text: "b" })).toContain("matches 2 locations (lines 1, 1)");
  expect(await failure({ path: "a.ts", old_text: "x", new_text: "x" })).toContain("identical");
  expect(await failure({ path: "a.ts", old_text: "", new_text: "x" })).toContain("nonempty");
  expect(await failure({ path: "a.ts", old_text: "x", new_text: "y", replace_all: "yes" })).toContain("replace_all must be a boolean");
  expect(await text("a.ts")).toBe(original);
});

test("replace_all replaces every occurrence, counts them and previews each", async () => {
  await writeFile(file("a.txt"), "old\nkeep\nkeep\nkeep\nold old\n");
  const result = JSON.parse(await edit.run({ path: "a.txt", old_text: "old", new_text: "new\nline", replace_all: true }, ctx));
  expect(await text("a.txt")).toBe("new\nline\nkeep\nkeep\nkeep\nnew\nline new\nline\n");
  expect(result.replacements).toBe(3);
  expect(result.preview).toBe("1: new\n2: line\n3: keep\n…\n5: keep\n6: new\n7: line new\n8: line\n9: ");
  expect(await failure({ path: "a.txt", old_text: "absent", new_text: "x", replace_all: true })).toContain("0 matches");
  const one = JSON.parse(await edit.run({ path: "a.txt", old_text: "keep\nkeep\nkeep\n", new_text: "", replace_all: true }, ctx));
  expect(one.replacements).toBe(1);
  expect(one.preview).toBe("2: line\n3: new\n4: line new");
});

test("the preview is bounded, with an explicit truncation marker", async () => {
  await writeFile(file("big.txt"), "start\nMARK\nend\n");
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${"é".repeat(300)}`).join("\n");
  const result = JSON.parse(await edit.run({ path: "big.txt", old_text: "MARK", new_text: long }, ctx));
  expect(Buffer.byteLength(result.preview)).toBeLessThanOrEqual(1100);
  expect(result.preview).toStartWith("1: start\n2: line 0 é");
  expect(result.preview).toMatch(/\n\[preview truncated before line \d+; 0 of 1 changed region shown in full\]$/);
  expect(result.preview).not.toContain("�");
  await writeFile(file("many.txt"), "x\n\n\n".repeat(300));
  const many = JSON.parse(await edit.run({ path: "many.txt", old_text: "x", new_text: "changed", replace_all: true }, ctx));
  expect(many.replacements).toBe(300);
  expect(Buffer.byteLength(many.preview)).toBeLessThanOrEqual(1100);
  expect(many.preview).toMatch(/\d+ of 300 changed regions shown in full\]$/);
  expect(editPreview("a\nb\nc", [{ start: 2, end: 3 }])).toBe("1: a\n2: b\n3: c");
});

test("a file changed by another writer between the read and the rename is left as that writer made it", async () => {
  await writeFile(file("raced.txt"), "one\ntwo\n");
  // The transform runs after the locked read and before publication: the place a concurrent writer lands.
  const raced = mutate(file("raced.txt"), undefined, old => { writeFileSync(file("raced.txt"), "theirs\n"); return { text: old.replace("two", "mine") }; }, false);
  await expect(raced).rejects.toThrow("file changed during edit; no changes applied");
  expect(await text("raced.txt")).toBe("theirs\n");
  expect(await readdir(cwd)).toEqual(["raced.txt"]);
});
