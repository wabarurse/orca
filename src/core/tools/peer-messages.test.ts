import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { directoryProject, paths, updateDirectory, writeProjectState } from "../../config";
import { initializeWorkspace } from "../data/projects/workspace";
import { execution } from "../data/projects/lifecycle";
import { consume, pending, put, userInEpoch } from "../data/inbox";
import { open } from "../data/transcripts";
import { createOrchestrator } from "../agent-loop/orc/orchestrator";
import { fakeProvider, text, toolUse } from "../../test/fake-provider";
import { format, parseFormatted, type Message } from "../../protocol";
import { runtime } from "./runtime";
import { message } from "./message";
import { peerTarget } from "./peer-messages";
import { read } from "./files";
import type { ToolContext } from "./registry";

let root: string, previous: string | undefined, ctx: ToolContext, outside: string;
beforeEach(async () => {
  previous = process.env.ORCA_HOME; root = mkdtempSync(join(tmpdir(), "orca-peers-"));
  process.env.ORCA_HOME = join(root, "home");
  const repo = join(root, "repo"); outside = join(root, "other");
  for (const directory of [repo, outside]) expect(Bun.spawnSync(["git", "init", "-q", "-b", "main", directory]).exitCode).toBe(0);
  await initializeWorkspace("one", repo); await initializeWorkspace("two", repo); await initializeWorkspace("other", outside);
  ctx = { project: "one", role: "orchestrator", cwd: repo };
});
afterEach(() => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  rmSync(root, { recursive: true, force: true });
});
async function received(project: string) {
  const out: Message[] = [];
  await consume(project, "orchestrator", open(paths.transcript(project, "orchestrator")), async rows => { out.push(...rows); });
  return out;
}

test("runtime discovers only same-checkout conversations with distinct addresses despite duplicate names", async () => {
  for (const id of ["one", "two"]) writeProjectState(id, "name", "same name");
  const snapshot = JSON.parse(await runtime.run({ action: "conversations", all_projects: true }, ctx) as string);
  expect(snapshot.conversations.map((row: any) => [row.id, row.name, row.address, row.current])).toEqual([
    ["one", "same name", "orchestrator@one", true], ["two", "same name", "orchestrator@two", false],
  ]);
  expect(snapshot.conversations.every((row: any) => row.queuedMessages === 0 && row.stopped === false)).toBe(true);
  expect(await pending("two", "orchestrator")).toBe(false);
});

test("peer messages and replies retain source identity and never become human input", async () => {
  const receipt = JSON.parse(await message.run({ to: "orchestrator@two", text: "I own api.ts. Which files do you own?" }, ctx) as string);
  expect(receipt).toMatchObject({ to: "orchestrator@two", enqueued: true, agentStarted: false, processingConfirmed: false, projectStopped: false });
  expect(await pending("one", "orchestrator")).toBe(false);
  expect(await userInEpoch("two", "orchestrator", execution.epoch("two"))).toBe(false);
  const rows = await received("two");
  expect(rows[0]).toMatchObject({ from: "orchestrator@one", text: "I own api.ts. Which files do you own?", inputId: receipt.inputId });
  expect(rows[0]!.userEpoch).toBeUndefined();
  expect(parseFormatted(format(rows))).toEqual(rows.map(({ from, text }) => ({ from, text })));
  await message.run({ to: rows[0]!.from, text: "I own ui.ts." }, { ...ctx, project: "two" });
  expect((await received("one"))[0]).toMatchObject({ from: "orchestrator@two", text: "I own ui.ts." });
});

test("active orchestrator loops consume and reply through their existing inboxes", async () => {
  const provider = fakeProvider([[toolUse("reply", "message", { to: "orchestrator@one", text: "I own ui.ts." })], [text("done")]]);
  const peer = await createOrchestrator({ project: "two", provider, tools: { message }, write() {} });
  try {
    await message.run({ to: "orchestrator@two", text: "Which files do you own?" }, ctx);
    expect(await peer.pending()).toBe(true);
    await peer.turn();
    expect(JSON.stringify(provider.calls[0]!.messages)).toContain("[orchestrator@one] Which files do you own?");
    expect(await peer.pending()).toBe(false);
    expect((await received("one"))[0]).toMatchObject({ from: "orchestrator@two", text: "I own ui.ts." });
    const requests = provider.calls.length;
    await peer.turn(); expect(provider.calls).toHaveLength(requests);
  } finally { peer.dispose?.(); }
});

test("stopped conversations retain peer mail without releasing the stop barrier or starting a turn", async () => {
  const provider = fakeProvider([]), peer = await createOrchestrator({ project: "two", provider, tools: { message }, write() {} });
  try {
    await execution.stop("two");
    const receipt = JSON.parse(await message.run({ to: "orchestrator@two", text: "Ready when you return." }, ctx) as string);
    expect(receipt).toMatchObject({ enqueued: true, agentStarted: false, projectStopped: true });
    expect(execution.stopped("two")).toBe(true);
    expect(await peer.pending()).toBe(false); expect(provider.calls).toEqual([]);
    expect(await pending("two", "orchestrator")).toBe(true);
    const snapshot = JSON.parse(await runtime.run({ action: "conversations" }, ctx) as string);
    expect(snapshot.conversations.find((row: any) => row.id === "two")).toMatchObject({ stopped: true, queuedMessages: 1 });
  } finally { peer.dispose?.(); }
});

test("cross-checkout, self, invalid-address, worker and image forwarding attempts never publish", async () => {
  for (const cwd of [ctx.cwd, outside]) expect(Bun.spawnSync(["git", "-C", cwd, "config", "remote.origin.url", "https://example.invalid/shared.git"]).exitCode).toBe(0);
  for (const to of ["orchestrator@other", "orchestrator@one", "orchestrator@missing", "orchestrator@../two", "worker@two", "../../other/inbox/orchestrator", "/tmp/inbox"]) {
    await expect(message.run({ to, text: "not sent" }, ctx)).rejects.toThrow();
  }
  await expect(message.run({ to: "orchestrator@two", text: "not sent" }, { ...ctx, role: "worker", branch: "work" })).rejects.toThrow("only orchestrators");
  await expect(message.run({ to: "orchestrator@two", text: "not sent", attachments: [crypto.randomUUID()] }, ctx)).rejects.toThrow("text-only");
  for (const id of ["one", "two", "other"]) expect(await pending(id, "orchestrator")).toBe(false);
});

test("large peer reports require a summary and place full evidence in the recipient's readable store", async () => {
  const full = "checked revision abc123\n".repeat(200);
  await expect(message.run({ to: "orchestrator@two", text: full }, ctx)).rejects.toThrow("summary");
  expect(await pending("two", "orchestrator")).toBe(false);
  await message.run({ to: "orchestrator@two", text: full, summary: "abc123: verified api.ts; ui.ts untouched." }, ctx);
  const [report] = await received("two"), file = report!.text.split("Full evidence: ")[1]!;
  expect(report!.text.length).toBeLessThan(2000);
  expect(await Bun.file(file).text()).toBe(full.trim());
  expect(JSON.parse(await read.run({ path: file, lines: 300 }, { ...ctx, project: "two" }) as string).content).toContain("200: checked revision abc123");
});

test("publication rechecks scope, cancellation and immutable receiver identity", async () => {
  const route = peerTarget("orchestrator@two", ctx)!;
  const parent = directoryProject(paths.memory, "two")!, moved = join(root, "moved");
  expect(Bun.spawnSync(["git", "init", "-q", "-b", "main", moved]).exitCode).toBe(0);
  updateDirectory(paths.memory, parent.id, { directory: moved });
  await expect(put("two", "orchestrator", { from: route.from, text: "stale" }, route.check)).rejects.toThrow("same checkout");
  updateDirectory(paths.memory, parent.id, { directory: ctx.cwd });
  rmSync(paths.project("two"), { recursive: true }); await initializeWorkspace("two", ctx.cwd);
  await expect(put("two", "orchestrator", { from: route.from, text: "stale" }, route.check)).rejects.toThrow("project changed");
  const controller = new AbortController(), cancelled = peerTarget("orchestrator@two", { ...ctx, signal: controller.signal })!;
  controller.abort();
  await expect(put("two", "orchestrator", { from: cancelled.from, text: "stale" }, cancelled.check)).rejects.toThrow();
  const active = peerTarget("orchestrator@two", { ...ctx, executionEpoch: execution.epoch("one") })!;
  await execution.stop("one");
  await expect(put("two", "orchestrator", { from: active.from, text: "stale" }, active.check)).rejects.toThrow("stopped");
  expect(await pending("two", "orchestrator")).toBe(false);
});
