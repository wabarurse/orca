// Actual durable question/inbox/transcript integration, with fake providers only.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../../config/config";
import { pendingInput, put, userInEpoch } from "../../data/inbox/inbox";
import { createOrchestrator } from "./orchestrator";
import { all, answer, ask, list, skip } from "../../data/inbox/questions";
import { inputEpoch } from "../../data/inbox/user-input";
import { fakeProvider, text } from "../../../test/fake-provider";
import { open } from "../../data/transcripts/transcript";

const home = mkdtempSync(join(tmpdir(), "silent-skip-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("silent skip produces no model input, pending user message or provider call, even on restart", async () => {
  const project = "idle";
  const provider = fakeProvider([]);
  const deliveries: unknown[] = [];
  const options = { project, provider, tools: {}, write() {}, onInbox: (messages: unknown) => { deliveries.push(messages); } };
  const orch = await createOrchestrator(options);
  const [q] = await ask(project, [{ text: "Approve?", default: "yes" }]);
  const before = await open(paths.transcript(project, "orchestrator")).chain();
  await skip(project, q!.id);
  expect(await pendingInput(project, "orchestrator")).toBe(false);
  expect(await orch.pending()).toBe(false);
  expect(await orch.turn()).toEqual([]);
  const restarted = await createOrchestrator(options);
  expect(await restarted.pending()).toBe(false);
  expect(await restarted.turn()).toEqual([]);
  expect(await list(project)).toEqual([]);
  expect((await all(project))[0]).toEqual({ ...q!, status: "skipped" });
  expect(await open(paths.transcript(project, "orchestrator")).chain()).toEqual(before);
  expect(provider.calls).toEqual([]); expect(deliveries).toEqual([]);
});

test("skip never resumes cancelled work or delivers held reports; an explicit suggested answer still does", async () => {
  const project = "cancelled";
  const provider = fakeProvider([[text("explicit answer received")]]);
  const deliveries: unknown[] = [];
  const orch = await createOrchestrator({ project, provider, tools: {}, write() {}, onInbox: messages => { deliveries.push(messages); } });
  await orch.say("previous input");
  orch.cancel!();
  await put(project, "orchestrator", { from: "worker-other", text: "held report" });
  const [dismiss, explicit] = await ask(project, [{ text: "Skip approval?", default: "yes" }, { text: "Which DB?", default: "sqlite" }]);
  await skip(project, dismiss!.id);
  expect(await userInEpoch(project, "orchestrator", inputEpoch(project))).toBe(false);
  expect(await orch.pending()).toBe(false);
  expect(await orch.turn()).toEqual([]);
  expect(provider.calls).toEqual([]); expect(deliveries).toEqual([]);
  await answer(project, explicit!.id, "sqlite");
  expect(await orch.pending()).toBe(true);
  await orch.turn();
  expect(provider.calls).toHaveLength(1);
  const input = JSON.stringify(provider.calls[0]!.messages);
  expect(input).toContain('Which DB?'); expect(input).toContain("sqlite"); expect(input).toContain("held report");
  expect(input).not.toContain("Skip approval?"); expect(input).not.toContain("skipped"); expect(input).not.toContain("use your default");
});

test("dismissing after an in-progress turn is cancelled does not restart the provider", async () => {
  const project = "aborted-turn";
  let began!: () => void, calls = 0, aborted = false;
  const started = new Promise<void>(resolve => { began = resolve; });
  const provider: import("../../../providers").Provider = {
    name: "anthropic", async models() { return []; },
    async complete(request) {
      calls++; began();
      return new Promise((_resolve, reject) => request.signal!.addEventListener("abort", () => {
        aborted = true; reject(request.signal!.reason);
      }, { once: true }));
    },
  };
  const orch = await createOrchestrator({ project, provider, tools: {}, write() {} });
  await orch.say("original request");
  const turn = orch.turn(); await started;
  orch.cancel!(); await turn; expect(aborted).toBe(true);
  const before = await open(paths.transcript(project, "orchestrator")).chain();
  const [q] = await ask(project, [{ text: "Resume?", default: "yes" }]);
  await skip(project, q!.id);
  expect(await orch.pending()).toBe(false);
  expect(await orch.turn()).toEqual([]);
  expect(calls).toBe(1);
  expect(await pendingInput(project, "orchestrator")).toBe(false);
  expect(await open(paths.transcript(project, "orchestrator")).chain()).toEqual(before);
});
