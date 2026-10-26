import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "./transcript";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orca-transcript-"));
  path = join(dir, "nested", "t.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const user = (text: string) => ({ type: "message" as const, parentUuid: null, message: { role: "user" as const, content: text } });
const assistant = (text: string) => ({ type: "message" as const, parentUuid: null, message: { role: "assistant" as const, content: text } });

describe("transcript", () => {
  test("append fills uuid/ts/parent, head and chain follow", async () => {
    const t = open(path);
    expect(t.head()).toBeNull();
    expect(await t.chain()).toEqual([]);

    const meta = await t.append({ type: "meta", role: "worker", model: "m" });
    const a = await t.append(user("hi"));
    const b = await t.append(assistant("hello"));

    expect(meta.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(meta.ts)).not.toBeNaN();
    expect(meta.parentUuid).toBeNull();
    expect(a.parentUuid).toBe(meta.uuid);
    expect(b.parentUuid).toBe(a.uuid);
    expect(t.head()).toBe(b.uuid);
    expect(await t.chain()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);

    const lines = (await readFile(path, "utf8")).split("\n");
    expect(lines.length).toBe(4); // 3 entries + trailing newline
    expect(lines[3]).toBe("");
  });

  test("resumes from an existing file", async () => {
    const t1 = open(path);
    await t1.append(user("one"));
    const last = await t1.append(assistant("two"));

    const t2 = open(path);
    expect(t2.head()).toBe(last.uuid);
    const next = await t2.append(user("three"));
    expect(next.parentUuid).toBe(last.uuid);
    expect(await t2.chain()).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
  });

  test("chain stops at the latest summary", async () => {
    const t = open(path);
    await t.append(user("old"));
    await t.append(assistant("older reply"));
    await t.append({ type: "summary", text: "so far: greeted" });
    await t.append(user("new"));

    expect(await t.chain()).toEqual([
      { role: "user", content: "so far: greeted" },
      { role: "user", content: "new" },
    ]);
  });

  test("explicit parentUuid is kept, enabling branches", async () => {
    const t = open(path);
    const root = await t.append(user("root"));
    await t.append(assistant("branch a"));
    const b = await t.append({ ...assistant("branch b"), parentUuid: root.uuid });
    expect(b.parentUuid).toBe(root.uuid);
    expect(await t.chain()).toEqual([
      { role: "user", content: "root" },
      { role: "assistant", content: "branch b" },
    ]);
  });

  test("ignores a partial last line", async () => {
    const t1 = open(path);
    const a = await t1.append(user("ok"));
    await appendFile(path, '{"uuid":"broken","type":"mess');

    const t2 = open(path);
    expect(t2.head()).toBe(a.uuid);
    expect(await t2.chain()).toEqual([{ role: "user", content: "ok" }]);
  });
});
