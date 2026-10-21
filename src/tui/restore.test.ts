import { expect, test } from "bun:test";
import { format } from "../inbox";
import type { Entry } from "../transcript";
import { lineRows, type Line } from "./app";
import { earlier, MAX_RESTORED_ROWS, restore, restoreMessages, SUMMARIZED, toolLine } from "./restore";
import { bold, dim } from "./render";

/** A fixture transcript: entries chained in order unless a parent is given. */
function transcript(...items: (Omit<Entry, "uuid" | "parentUuid" | "ts"> & { parentUuid?: string | null; uuid?: string })[]): Entry[] {
  const out: Entry[] = [];
  for (const [i, item] of items.entries()) {
    const parentUuid = item.parentUuid !== undefined ? item.parentUuid : (out.at(-1)?.uuid ?? null);
    out.push({ ...item, uuid: item.uuid ?? `u${i}`, parentUuid, ts: "t" } as Entry);
  }
  return out;
}
const meta = { type: "meta", role: "orchestrator", model: "m" } as const;
const user = (content: unknown, extra = {}) => ({ type: "message", message: { role: "user", content }, ...extra }) as never;
const assistant = (content: unknown, extra = {}) => ({ type: "message", message: { role: "assistant", content }, ...extra }) as never;
const inbox = (...msgs: [string, string][]) => format(msgs.map(([from, text]) => ({ from, text, ts: "" })));
const raw = (l: Line) => (typeof l === "string" ? l : l.md);

test("user messages, agent reports, assistant markdown and replies; tool calls as live, results and thinking hidden", () => {
  const entries = transcript(
    meta,
    user(inbox(["user", "build a login\npage please"])),
    assistant([
      { type: "thinking", thinking: "hmm", signature: "s" },
      { type: "text", text: "# Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |\n" },
      { type: "tool_use", id: "t1", name: "spawn", input: { branch: "feat/login" } },
    ]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "started worker-feat-login" }, { type: "text", text: inbox(["worker-feat-login", "Done.\n\nAll green."]) }]),
    assistant([{ type: "tool_use", id: "t2", name: "message", input: { to: "user", text: "Login is **done**." } }, { type: "tool_use", id: "t3", name: "message", input: { to: "user", text: "refused one" } }]),
    user([{ type: "tool_result", tool_use_id: "t2", content: "sent to user" }, { type: "tool_result", tool_use_id: "t3", content: "refused: empty message", is_error: true }]),
    assistant([{ type: "text", text: "All set." }]),
  );
  const lines = restore(entries, 60);
  expect(lines).toEqual([
    `${bold(">")} build a login`, "  page please",
    { md: "# Plan", block: true }, { md: "", block: true }, { md: "| a | b |\n|---|---|\n| 1 | 2 |", block: true },
    toolLine("spawn", { branch: "feat/login" }),
    dim("From worker-feat-login: Done.…"),
    toolLine("message", { to: "user", text: "Login is **done**." }),
    toolLine("message", { to: "user", text: "refused one" }),
    { md: "All set.", block: true },
    { md: "Login is **done**.", label: bold("orchestrator") },
  ]);
  expect(lines.some((l) => raw(l).includes("started worker") || raw(l).includes("hmm"))).toBe(false);
});

test("the tool line is what agent.ts writes live", async () => {
  const src = await Bun.file(new URL("../agent.ts", import.meta.url)).text();
  expect(src).toContain("write(`\\x1b[2m▸ ${block.name} ${JSON.stringify(block.input).slice(0, 100)}\\x1b[0m\\n`, true);");
});

test("a summary: only the branch from the head back to it, led by a dim note", () => {
  const entries = transcript(
    meta,
    user(inbox(["user", "old question"])),
    assistant([{ type: "text", text: "old answer" }]),
    // An abandoned fork off the first user message.
    assistant([{ type: "text", text: "forked answer" }], { parentUuid: "u1", uuid: "fork" }),
    { type: "summary", text: "the user asked an old question", parentUuid: "u2" } as never,
    user(inbox(["user", "new question"])),
    assistant([{ type: "text", text: "new answer" }]),
  );
  expect(restore(entries, 60)).toEqual([SUMMARIZED, `${bold(">")} new question`, { md: "new answer", block: true }]);
});

test("the head's branch wins over a later-abandoned fork", () => {
  const entries = transcript(meta, user(inbox(["user", "q"])), assistant([{ type: "text", text: "first try" }]), assistant([{ type: "text", text: "retry" }], { parentUuid: "u1" }));
  expect(restore(entries, 60).map(raw)).toEqual([`${bold(">")} q`, "retry"]);
});

test("a long history keeps the newest whole messages within the cap, led by how many were left out", () => {
  const items = [meta as never];
  for (let i = 0; i < 150; i++) items.push(user(inbox(["user", `question ${i}`])), assistant([{ type: "text", text: `answer ${i}\nline two` }]));
  const entries = transcript(...items);
  const lines = restore(entries, 60);
  const rows = lines.slice(1).flatMap((l) => lineRows(l, 60));
  expect(rows.length).toBe(MAX_RESTORED_ROWS);
  const total = restoreMessages(entries).length;
  // 300 messages of 1 and 2 rows: the newest 133 fill exactly 200 rows, so 167 were left out.
  expect(total).toBe(300);
  expect(lines[0]).toBe(earlier(167));
  expect(raw(lines.at(-1)!)).toBe("line two");
  expect(raw(lines[1]!)).toBe("answer 83");
  // Under the cap nothing is left out; a newest message longer than the cap still shows whole.
  expect(restore(transcript(meta, user(inbox(["user", "hi"]))), 60)).toEqual([`${bold(">")} hi`]);
  const huge = restore(transcript(meta, user(inbox(["user", "hi"])), assistant([{ type: "text", text: Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n") }])), 60);
  expect(huge[0]).toBe(earlier(1));
  expect(huge.length).toBe(301);
});

test("an empty or missing transcript restores nothing", () => {
  expect(restore([], 60)).toEqual([]);
  expect(restore(transcript(meta), 60)).toEqual([]);
});

test("the user's lines lead an inbox turn they share with agent reports, as they were shown when sent", () => {
  const entries = transcript(meta, user(inbox(["worker-a", "report"], ["user", "hi"])));
  expect(restore(entries, 60)).toEqual([`${bold(">")} hi`, dim("From worker-a: report")]);
});
