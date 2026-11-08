import { expect, test } from "bun:test";
import { appFixture } from "../test/app-fixture";
import { App, type ToolEvents } from "./app";
import type { Message } from "../protocol";
import { open } from "../core/data/transcripts";
import { paths } from "../config";

const { fakeTerm, until, bodyStart, settle } = appFixture();

async function fixture() {
  const project = `follow-${crypto.randomUUID()}`, record = open(paths.transcript(project, "orchestrator"));
  await record.append({ type: "message", message: { role: "assistant", content: Array.from({ length: 80 }, (_, i) => `history ${i}`).join("\n") } });
  const term = fakeTerm(80, 24);
  let inbox!: (messages: Message[]) => void, hooks!: ToolEvents, write!: (text: string) => void;
  const app = new App({ term, pollMs: 100_000, watchdog: async () => {}, merges: async () => {}, agents: async () => [],
    openOrchestrator: async (_project, _directory, output, onInbox, tools) => {
      inbox = onInbox!; hooks = tools!; write = output;
      return { say: async () => {}, pending: async () => false, turn: async () => [], entries: () => record.history!(), refresh: async () => true };
    },
  });
  const running = app.run(project);
  await until(() => !!app.page && term.screen().includes("history 79"));
  return { app, term, record, inbox, hooks, write, stop: async () => { app.quit(); await running; } };
}

test("worker, reviewer, runtime and external-user messages follow through passive transcript refresh", async () => {
  const f = await fixture();
  try {
    for (const from of ["worker-task", "reviewer-task", "runtime", "user"]) {
      f.term.press({ name: "pageup" }); await until(() => !f.term.screen().includes("history 79"));
      const message = { from, text: `${from} has new work`, inputId: crypto.randomUUID(), ts: new Date().toISOString(), deliveryId: crypto.randomUUID() };
      await f.record.append({ type: "message", inbox: [message], message: { role: "user", content: `[${from}] ${message.text}` } });
      await f.app.refreshSessions();
      await until(() => f.term.screen().includes(message.text));
      f.write(`answer to ${from}\n`);
      await until(() => f.term.screen().includes(`answer to ${from}`));
      // Preserve real streamed output in the record before the next refresh.
      await f.record.append({ type: "message", message: { role: "assistant", content: `answer to ${from}` } });
      f.hooks.onRefresh?.();
      await settle();
    }
    expect(f.app.input.text).toBe("");
  } finally { await f.stop(); }
});

test("live inbox delivery follows once, not again when the same receipt is restored", async () => {
  const f = await fixture();
  try {
    f.term.press({ name: "pageup" }); await until(() => !f.term.screen().includes("history 79"));
    const message = { from: "worker-task", text: "worker result arrived", inputId: crypto.randomUUID(), ts: "now", deliveryId: crypto.randomUUID() };
    f.inbox([message]);
    await until(() => f.term.screen().includes(message.text));
    f.term.press({ name: "pageup" }); await until(() => !f.term.screen().includes(message.text));
    const top = f.term.display.screen()[bodyStart(f.term)];
    await f.record.append({ type: "message", inbox: [message], message: { role: "user", content: `[${message.from}] ${message.text}` } });
    f.hooks.onRefresh?.(); await settle();
    expect(f.term.display.screen()[bodyStart(f.term)]).toBe(top);
  } finally { await f.stop(); }
});

test("a click temporarily pins selection but release restores following even if output arrived meanwhile", async () => {
  const f = await fixture();
  try {
    const y = bodyStart(f.term) + 1;
    f.term.press({ name: "mousedown", x: 2, y });
    f.write("message during click\n");
    f.term.press({ name: "mouseup", x: 2, y });
    await until(() => f.term.screen().includes("message during click"));
    f.write("message after click\n");
    await until(() => f.term.screen().includes("message after click"));
    f.term.press({ name: "pageup" }); await until(() => !f.term.screen().includes("message after click"));
    const before = f.term.display.screen()[bodyStart(f.term)];
    f.write("continuing response while reading\n"); await settle();
    expect(f.term.display.screen()[bodyStart(f.term)]).toBe(before);
  } finally { await f.stop(); }
});
