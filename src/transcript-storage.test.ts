import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { disk, type Storage } from "./transcript-storage";
import { open } from "./transcript";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function fixture(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "publish-")); dirs.push(dir);
  let fault = false;
  const warnings: string[] = [];
  const io: Storage = { ...disk, warn: s => { warnings.push(s); if (mode === "warning-error") throw Error("broken logger"); },
    async rename(from, to) { if (fault && mode === "rename") throw Error("rename error"); await disk.rename(from, to); },
    async open(path, flags) {
      const file = await disk.open(path, flags);
      return {
        async write(bytes) {
          if (fault && mode === "zero") return { bytesWritten: 0 };
          if (fault && mode === "partial-error") { await file.write(bytes.subarray(0, 7)); throw Error("partial error"); }
          return file.write(fault && mode === "short" ? bytes.subarray(0, 7) : bytes);
        },
        async sync() { if (fault && (mode === "sync" && flags === "wx" || ["directory", "warning-error"].includes(mode) && flags === "r")) throw Error("sync error"); await file.sync(); },
        async close() { await file.close(); if (fault && (mode === "close" && flags === "wx" || mode === "directory-close" && flags === "r")) throw Error("close error"); },
      };
    },
  };
  return { path: join(dir, "t.jsonl"), io, warnings, fault: (value: boolean) => { fault = value; } };
}
for (const mode of ["short", "zero", "partial-error", "sync", "close", "rename", "directory", "directory-close", "warning-error"]) test(`publication ${mode}: durable visible record and head agree, next append/reopen safe`, async () => {
  const f = fixture(mode), t = open(f.path, f.io);
  await t.append({ type: "message", message: { role: "user", content: "original" } });
  const before = await Bun.file(f.path).text(), head = t.head();
  f.fault(true);
  const operation = t.append({ type: "summary", text: "summary", retained: [], boundary: head });
  if (["short", "directory", "directory-close", "warning-error"].includes(mode)) {
    await operation;
    expect(t.head()).not.toBe(head);
    expect((await Bun.file(f.path).text()).startsWith(before)).toBe(true);
  } else {
    await expect(operation).rejects.toThrow();
    expect(t.head()).toBe(head); expect(await Bun.file(f.path).text()).toBe(before);
  }
  expect(open(f.path).head()).toBe(t.head());
  expect(await open(f.path).chain()).toEqual(await t.chain());
  if (mode === "directory") expect(f.warnings[0]).toContain("committed");
  f.fault(false);
  await t.append({ type: "message", message: { role: "user", content: "after" } });
  expect(await open(f.path).chain()).toEqual(await t.chain());
  expect(open(f.path).history!()).toEqual(t.history!());
});
