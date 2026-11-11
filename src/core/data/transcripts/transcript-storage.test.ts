import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { APPEND, disk, publish, type RecordFile, type Storage } from "./transcript-storage";
import { open } from "./transcript";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "publish-")); dirs.push(dir); return join(dir, "t.jsonl"); };
const message = (content: string) => ({ type: "message" as const, message: { role: "user" as const, content } });

/** Faults on the transcript's own handle (APPEND) or its directory's ("r"), switched on after the first append. */
function fixture(mode: string) {
  let fault = false;
  const warnings: string[] = [];
  const io: Storage = { ...disk, warn: s => { warnings.push(s); if (mode === "warning-error") throw Error("broken logger"); },
    async open(path, flags) {
      const file = await disk.open(path, flags), record = flags === APPEND, on = (...modes: string[]) => fault && modes.includes(mode);
      return { ...file,
        async write(bytes) {
          if (on("zero")) return { bytesWritten: 0 };
          if (on("partial-error", "partial-stuck")) { await file.write(bytes.subarray(0, 7)); throw Error("partial error"); }
          if (on("whole-error-stuck")) { await file.write(bytes.subarray(0, bytes.length - 1)); throw Error("late error"); }
          return file.write(on("short") ? bytes.subarray(0, 7) : bytes);
        },
        async sync() { if (record ? on("sync", "sync-stuck") : on("directory", "warning-error")) throw Error("sync error"); await file.sync(); },
        async close() { await file.close(); if (record ? on("close") : on("directory-close")) throw Error("close error"); },
        async truncate(length) { if (on("partial-stuck", "whole-error-stuck", "sync-stuck")) throw Error("truncate error"); await file.truncate(length); },
      };
    },
  };
  return { path: temp(), io, warnings, fault: (value: boolean) => { fault = value; } };
}
// What the caller is told, and what a reader then finds: "committed" (record visible, head moved),
// "unchanged" (exact old bytes) or "torn" (old bytes plus an unreadable tail, head unmoved).
const outcomes: Record<string, "committed" | "unchanged" | "torn"> = {
  short: "committed", close: "committed", "whole-error-stuck": "committed", "sync-stuck": "committed",
  zero: "unchanged", "partial-error": "unchanged", sync: "unchanged", "partial-stuck": "torn",
};
for (const type of ["summary", "context-boundary"] as const) for (const [mode, outcome] of Object.entries(outcomes)) test(`append ${type} ${mode}: ${outcome}; visible record and head agree, next append/reopen safe`, async () => {
  const f = fixture(mode), t = open(f.path, f.io);
  await t.append(message("original"));
  const before = await Bun.file(f.path).text(), head = t.head();
  f.fault(true);
  const operation = t.append(type === "summary" ? { type, text: "summary", retained: [], boundary: head } : { type });
  if (outcome === "committed") {
    await operation;
    expect(t.head()).not.toBe(head);
  } else {
    await expect(operation).rejects.toThrow();
    expect(t.head()).toBe(head);
  }
  const after = await Bun.file(f.path).text();
  expect(after.startsWith(before)).toBe(true);
  if (outcome === "unchanged") expect(after).toBe(before);
  if (outcome === "torn") expect(after.length).toBe(before.length + 7);
  if (mode === "close") expect(f.warnings[0]).toContain("committed");
  if (mode.endsWith("-stuck") && outcome === "committed") expect(f.warnings[0]).toContain("stays committed");
  expect(open(f.path).head()).toBe(t.head());
  expect(await open(f.path).chain()).toEqual(await t.chain());
  f.fault(false);
  const next = await t.append(message("after"));
  expect(open(f.path).head()).toBe(next.uuid);
  expect(await open(f.path).chain()).toEqual(await t.chain());
  expect(open(f.path).history!()).toEqual(t.history!());
  expect((await Bun.file(f.path).text()).startsWith(before)).toBe(true);
});

for (const mode of ["directory", "directory-close", "warning-error"]) test(`creating append with ${mode} failure is committed, a warning at most`, async () => {
  const f = fixture(mode), t = open(f.path, f.io);
  f.fault(true);
  const entry = await t.append(message("first"));
  expect(open(f.path).head()).toBe(entry.uuid);
  expect(f.warnings).toHaveLength(1);
  if (mode !== "warning-error") expect(f.warnings[0]).toContain("committed");
  await t.append(message("second"));
  expect(f.warnings).toHaveLength(1); // only a creating append syncs the directory
  expect(await open(f.path).chain()).toEqual(await t.chain());
});

for (const type of ["summary", "context-boundary"] as const) for (const boundary of ["open", "write", "sync", "authorize", "committed", "close"]) test(`${type} cancellation at ${boundary}: precommit preserves bytes/head, postcommit remains published`, async () => {
  const path = temp(), controller = new AbortController();
  let armed = false;
  const cancel = (at: string) => { if (armed && at === boundary) controller.abort(Error("cancelled checkpoint")); };
  const io: Storage = { ...disk,
    async open(p, flags) {
      const file = await disk.open(p, flags);
      if (flags !== APPEND) return file;
      cancel("open");
      return { ...file,
        async write(bytes) { const result = await file.write(bytes); cancel("write"); return result; },
        async sync() { await file.sync(); cancel("sync"); },
        async close() { await file.close(); cancel("close"); },
      };
    },
  };
  const t = open(path, io);
  await t.append(message("keep exact original bytes"));
  const before = await Bun.file(path).text(), head = t.head();
  armed = true;
  const entry = type === "summary" ? { type, text: "summary", retained: [], boundary: head } : { type };
  const guard = { head, check: () => { if (armed && boundary === "authorize") throw Error("cancelled checkpoint"); } };
  // "committed": the abort lands right after the commit, as a late cancellation would.
  const op = t.append(entry, controller.signal, boundary === "authorize" ? guard : undefined);
  if (boundary === "committed") void op.then(() => controller.abort(Error("cancelled checkpoint")));
  if (["committed", "close"].includes(boundary)) {
    await op;
    expect(t.head()).not.toBe(head);
    expect((await Bun.file(path).text()).startsWith(before)).toBe(true);
  } else {
    await expect(op).rejects.toThrow("cancelled checkpoint");
    expect(t.head()).toBe(head);
    expect(await Bun.file(path).text()).toBe(before);
  }
  expect(open(path).head()).toBe(t.head());
  expect(await open(path).chain()).toEqual(await t.chain());
  expect(readdirSync(join(path, "..")).filter(p => p.endsWith(".pending"))).toEqual([]);
  // Mandatory tool-result cleanup is intentionally nonabortable.
  await t.append({ type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "cancelled-tool", content: "Cancelled by user", is_error: true }] } });
  expect(open(path).head()).toBe(t.head());
});

/** In-memory file that records every call, so the order and the bytes touched can be asserted. */
function recorder(initial = "") {
  const calls: string[] = [];
  let bytes = Buffer.from(initial), fullReads = 0, opened = 0;
  const file: RecordFile = {
    async write(buffer) { calls.push(`write:${buffer.length}`); bytes = Buffer.concat([bytes, buffer]); return { bytesWritten: buffer.length }; },
    async sync() { calls.push("sync"); },
    async close() { calls.push("close"); },
    async size() { calls.push("size"); return bytes.length; },
    async byteAt(position) { calls.push("byteAt"); return bytes[position]; },
    async truncate(length) { calls.push(`truncate:${length}`); bytes = bytes.subarray(0, length); },
  };
  const io: Storage = {
    async open(_, flags) { calls.push(`open:${flags}`); opened++; return flags === APPEND ? file : { ...file, sync: async () => { calls.push("dirsync"); }, close: async () => { calls.push("dirclose"); } }; },
    async read() { fullReads++; return bytes; },
    warn: s => { calls.push(`warn:${s}`); },
  };
  return { io, calls, text: () => bytes.toString(), fullReads: () => fullReads, opened: () => opened };
}

test("publish order: nothing is written before the abort check, authorize is last before the commit, committed runs once", async () => {
  const r = recorder('{"a":1}\n'), record = '{"b":2}';
  await publish("t.jsonl", record, r.io, () => r.calls.push("committed"), undefined, () => r.calls.push("authorize"));
  expect(r.calls).toEqual(["open:a+", "size", "byteAt", `write:${record.length + 1}`, "sync", "authorize", "committed", "close"]);
  expect(r.text()).toBe('{"a":1}\n{"b":2}\n');
  expect(r.fullReads()).toBe(0);

  const aborted = recorder("x\n"), controller = new AbortController();
  controller.abort(Error("stop"));
  await expect(publish("t.jsonl", record, aborted.io, () => aborted.calls.push("committed"), controller.signal)).rejects.toThrow("stop");
  expect(aborted.calls).toEqual([]);

  const refused = recorder("x\n");
  await expect(publish("t.jsonl", record, refused.io, () => refused.calls.push("committed"), undefined, () => { throw Error("refused"); })).rejects.toThrow("refused");
  expect(refused.calls).toEqual(["open:a+", "size", "byteAt", `write:${record.length + 1}`, "sync", "truncate:2", "sync", "close"]);
  expect(refused.text()).toBe("x\n");
});

test("a new file is created 0600 and its directory synced once; a torn tail gets a separator and later records stay readable", async () => {
  const created = recorder();
  await publish("t.jsonl", "{}", created.io);
  expect(created.calls).toEqual(["open:a+", "size", "write:3", "sync", "close", "open:r", "dirsync", "dirclose"]);

  const path = temp(), t = open(path);
  const first = await t.append(message("one"));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const inode = statSync(path).ino;
  appendFileSync(path, '{"type":"message","uuid":"torn","message":{"role":"us'); // a crash mid-write
  expect(open(path).head()).toBe(first.uuid);
  const second = await open(path).append(message("two"));
  expect(second.parentUuid).toBe(first.uuid);
  const third = await open(path).append(message("three"));
  expect(open(path).head()).toBe(third.uuid);
  expect((await open(path).chain()).map(m => m.content)).toEqual(["one", "two", "three"]);
  expect(await Bun.file(path).text()).toContain('"role":"us\n{');
  expect(statSync(path).ino).toBe(inode);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("appends to a multi-megabyte transcript write record-sized bytes and never read the file", async () => {
  const path = temp(), line = JSON.stringify({ type: "meta", uuid: "filler", pad: "x".repeat(1000) }) + "\n";
  writeFileSync(path, line.repeat(4096), { mode: 0o600 }); // about 4 MiB
  const size = statSync(path).size;
  let written = 0, fullReads = 0, probed = 0;
  const io: Storage = { ...disk, read: p => { fullReads++; return disk.read(p); },
    async open(p, flags) {
      const file = await disk.open(p, flags);
      return { ...file, write: async bytes => { written += bytes.length; return file.write(bytes); }, byteAt: position => { probed++; return file.byteAt(position); } };
    },
  };
  const records = Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: "meta", uuid: `u${i}`, text: "record ".repeat(10) }));
  for (const record of records) await publish(path, record, io);
  const expected = records.reduce((n, r) => n + Buffer.byteLength(r) + 1, 0);
  expect(written).toBe(expected);
  expect(probed).toBe(records.length);
  expect(fullReads).toBe(0);
  expect(statSync(path).size).toBe(size + expected);

  // Through the transcript: one load when it opens, then no whole-file read per append.
  const reads = { n: 0 }, original = disk.read;
  disk.read = p => { reads.n++; return original(p); };
  try {
    const t = open(path);
    for (let i = 0; i < 5; i++) await t.append(message(`m${i}`));
    expect(reads.n).toBe(1);
    expect(open(path).head()).toBe(t.head());
  } finally { disk.read = original; }
});
