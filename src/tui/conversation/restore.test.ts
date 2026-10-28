import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "../../protocol/inbox";
import { open } from "../../core/data/transcripts/transcript";
import type { Entry } from "../../protocol/transcript";
import { historyRows, lineRows, type Line } from "./lines";
import { earlier, MAX_RESTORED_ROWS, questionReply, replyLine, restore, restoreItems, unresolvedCalls } from "./restore";
import { toolView } from "../../protocol/toolview";
import { bold, dim } from "../components/text";
import { collapseCalls } from "./tools";

const dir = mkdtempSync(join(tmpdir(), "orca-restore-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;

/**
 * A fixture transcript file, entries chained in order unless a parent is
 * given, loaded the way the orchestrator loads it: the current branch.
 */
function transcript(...items: (Omit<Entry, "uuid" | "parentUuid" | "ts"> & { parentUuid?: string | null; uuid?: string })[]): Entry[] {
  const out: Entry[] = [];
  for (const [i, item] of items.entries()) {
    const parentUuid = item.parentUuid !== undefined ? item.parentUuid : (out.at(-1)?.uuid ?? null);
    out.push({ ...item, uuid: item.uuid ?? `u${i}`, parentUuid, ts: "t" } as Entry);
  }
  const path = join(dir, `t${files++}.jsonl`);
  writeFileSync(path, out.map((e) => JSON.stringify(e) + "\n").join(""));
  return open(path).branch();
}
const meta = { type: "meta", role: "orchestrator", model: "m" } as const;
const user = (content: unknown, extra = {}) => ({ type: "message", message: { role: "user", content }, ...extra }) as never;
const assistant = (content: unknown, extra = {}) => ({ type: "message", message: { role: "assistant", content }, ...extra }) as never;
const inbox = (...msgs: [string, string][]) => format(msgs.map(([from, text]) => ({ from, text, ts: "" })));
const raw = (l: Line) => (typeof l === "string" ? l : "user" in l ? l.user : "tool" in l ? `${l.tool} ⎿ ${l.summary}` : l.md);

test("user messages, agent reports, assistant markdown and replies; tool calls as live, results and thinking hidden", () => {
  const entries = transcript(
    meta,
    user(inbox(["user", "build a login\npage please"])),
    assistant([
      { type: "thinking", thinking: "hmm", signature: "s" },
      { type: "text", text: "# Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |\n" },
      { type: "tool_use", id: "t1", name: "spawn", input: { branch: "feat/login" } },
    ]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "worker-feat-login" }, { type: "text", text: inbox(["worker-feat-login", "Done.\n\nAll green."]) }]),
    assistant([{ type: "tool_use", id: "t2", name: "message", input: { to: "user", text: "Login is **done**." } }, { type: "tool_use", id: "t3", name: "message", input: { to: "user", text: "refused one" } }]),
    user([{ type: "tool_result", tool_use_id: "t2", content: "sent to user" }, { type: "tool_result", tool_use_id: "t3", content: "refused: empty message", is_error: true }]),
    assistant([{ type: "text", text: "All set." }]),
  );
  const lines = restore(entries, 60);
  expect(lines).toEqual([
    { user: `${bold(">")} build a login` }, { user: "  page please" },
    { md: "# Plan", block: true }, { md: "", block: true, continuation: true }, { md: "| a | b |\n|---|---|\n| 1 | 2 |", block: true, continuation: true },
    { tool: "spawn(feat/login, worker)", summary: "spawned worker-feat-login", failed: false },
    dim("from worker-feat-login: Done.…"),
    { tool: "message(user: Login is **done**.)", summary: "sent to user", failed: false },
    { tool: "message(user: refused one)", summary: "refused: empty message", failed: true },
    { md: "All set.", block: true },
    { md: "Login is **done**.", label: bold("orchestrator") },
  ]);
  expect(lines.some((l) => raw(l).includes("All green") || raw(l).includes("hmm"))).toBe(false);
});

test("a tool call restores as the line it showed when it ended, through the formatter agent.ts and the TUI use", async () => {
  const src = await Bun.file(new URL("../../core/agent-loop/loop/agent.ts", import.meta.url)).text();
  expect(src).toContain("callText(call)");
  expect(src).toContain("resultText(call.name, outcome)");
  const entries = transcript(
    meta,
    assistant([{ type: "tool_use", id: "b1", name: "bash", input: { command: "ls" } }, { type: "tool_use", id: "b2", name: "bash", input: { command: "false" } }]),
    user([{ type: "tool_result", tool_use_id: "b1", content: "a\nb\n" }, { type: "tool_result", tool_use_id: "b2", content: "boom\n[exit 1]" }]),
    assistant([{ type: "tool_use", id: "b3", name: "bash", input: { command: "sleep 9" } }]), // never got a result
  );
  expect(restore(entries, 60)).toEqual([
    toolView("bash", { command: "ls" }, { ok: true, text: "a\nb\n" }),
    { tool: "bash(false)", summary: "exit 1: boom", failed: true },
    { tool: "bash(sleep 9)", summary: "interrupted", failed: true },
  ]);
});

test("collapsed: a restored run of calls across assistant entries and their tool_result entries folds into one summary line, broken by text, a user message or a report; a lone call, and the expanded view, render as before", () => {
  const bash = (id: string, command: string) => ({ type: "tool_use", id, name: "bash", input: { command } });
  const result = (id: string, content: string, is_error = false) => ({ type: "tool_result", tool_use_id: id, content, is_error });
  const entries = transcript(
    meta,
    user(inbox(["user", "go"])),
    assistant([{ type: "text", text: "Looking" }, bash("b1", "ls"), bash("b2", "false")]),
    user([result("b1", "a\n"), result("b2", "boom\n[exit 1]")]),
    assistant([bash("b3", "cat x"), { type: "tool_use", id: "r1", name: "read", input: { path: "x" } }]), // no text: the run continues across entries
    user([result("b3", "x\n"), result("r1", "refused", true)]),
    assistant([bash("b4", "sleep 9")]), // never got a result: interrupted, failed
    user(inbox(["worker-a", "done"])), // a report breaks the run
    assistant([bash("b5", "pwd"), bash("b6", "id")]),
    user([result("b5", "/\n"), result("b6", "me\n")]),
    assistant([{ type: "text", text: "Done." }, bash("b7", "true")]), // a lone call keeps its own lines
    user([result("b7", "")]),
  );
  const lines = restore(entries, 60);
  const text = (shown: ReturnType<typeof collapseCalls>) => historyRows(shown, 60).map(row => Bun.stripANSI(row).trimEnd()).filter(Boolean);
  expect(text(collapseCalls(lines))).toEqual([
    "> go", "Looking",
    "▸ 5 tool calls · bash ×4, read ×1 · 3 failed",
    "from worker-a: done",
    "▸ 2 tool calls · bash ×2",
    "Done.", "⏺ bash(true)", "  ⎿  no output",
  ]);
  expect(text(lines)).toEqual([
    "> go", "Looking",
    "⏺ bash(ls)", "  ⎿  1 line", "⏺ bash(false)", "  ⎿  exit 1: boom", "⏺ bash(cat x)", "  ⎿  1 line", "⏺ read(x)", "  ⎿  refused", "⏺ bash(sleep 9)", "  ⎿  interrupted",
    "from worker-a: done",
    "⏺ bash(pwd)", "  ⎿  1 line", "⏺ bash(id)", "  ⎿  1 line",
    "Done.", "⏺ bash(true)", "  ⎿  no output",
  ]);
  // A run of calls still running is left out of the fold too: what remains folds, or stands alone.
  const mid = transcript(meta, assistant([bash("c1", "a"), bash("c2", "b"), bash("c3", "c")]), user([result("c1", ""), result("c2", "")]));
  expect(text(collapseCalls(restore(mid, 60, Infinity, unresolvedCalls(mid))))).toEqual(["▸ 2 tool calls · bash ×2"]);
  const one = transcript(meta, assistant([bash("c1", "a"), bash("c2", "b")]), user([result("c1", "")]));
  expect(text(collapseCalls(restore(one, 60, Infinity, unresolvedCalls(one))))).toEqual(["⏺ bash(a)", "  ⎿  no output"]);
  expect(text(collapseCalls(restore(one, 60)))).toEqual(["▸ 2 tool calls · bash ×2 · 1 failed"]); // once the turn is over, the lost call is interrupted
});

test("while a turn runs, the newest entry's calls without a result are left out (the live view shows them running) instead of interrupted; earlier ones and finished ones are untouched", () => {
  const entries = transcript(
    meta,
    assistant([{ type: "text", text: "old" }, { type: "tool_use", id: "a1", name: "bash", input: { command: "crashed" } }]), // an earlier run died mid-call
    user("next"),
    assistant([{ type: "text", text: "Looking" }, { type: "tool_use", id: "b1", name: "bash", input: { command: "ls" } }, { type: "tool_use", id: "b2", name: "echo", input: { what: "it" } }]),
    user([{ type: "tool_result", tool_use_id: "b1", content: "a\n" }]), // b2 still running
  );
  const running = unresolvedCalls(entries);
  expect([...running]).toEqual(["b2"]);
  const shown = (lines: Line[]) => lines.map(raw).map(Bun.stripANSI);
  expect(shown(restore(entries, 60, Infinity, running))).toEqual(["old", "bash(crashed) ⎿ interrupted", "> next", "Looking", "bash(ls) ⎿ 1 line"]);
  expect(shown(restore(entries, 60))).toEqual(["old", "bash(crashed) ⎿ interrupted", "> next", "Looking", "bash(ls) ⎿ 1 line", "echo(it) ⎿ interrupted"]);
  // An entry holding only a running call shows nothing yet; a resolved record has nothing to leave out.
  const only = transcript(meta, assistant([{ type: "tool_use", id: "c1", name: "bash", input: { command: "x" } }]));
  expect(restore(only, 60, Infinity, unresolvedCalls(only))).toEqual([]);
  expect(restoreItems(only, unresolvedCalls(only))).toEqual([]);
  expect(unresolvedCalls(transcript(meta, assistant([{ type: "tool_use", id: "c1", name: "bash", input: {} }]), user([{ type: "tool_result", tool_use_id: "c1", content: "" }]))).size).toBe(0);
  expect(unresolvedCalls([])).toEqual(new Set());
});

test("a summary: restore conversation content without status metadata", () => {
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
  expect(restore(entries, 60)).toEqual([{ user: `${bold(">")} new question` }, { md: "new answer", block: true }]);
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
  const rows = historyRows(lines, 60);
  expect(rows.length).toBe(MAX_RESTORED_ROWS - 1);
  const total = restoreItems(entries).length;
  // Spaced display, including omission note: 79 whole messages fill 199 rows; one more would exceed 200.
  expect(total).toBe(300);
  expect(lines[0]).toBe(earlier(221));
  expect(raw(lines.at(-1)!)).toBe("line two");
  expect(raw(lines[1]!)).toBe("answer 110");
  // Under the cap nothing is left out; a newest message longer than the cap still shows whole.
  expect(restore(transcript(meta, user(inbox(["user", "hi"]))), 60)).toEqual([{ user: `${bold(">")} hi` }]);
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
  expect(restore(entries, 60)).toEqual([{ user: `${bold(">")} hi` }, dim("from worker-a: report")]);
});

const sentTo = (id: string, to: string, text: string) => [
  assistant([{ type: "tool_use", id, name: "message", input: { to, text } }]),
  user([{ type: "tool_result", tool_use_id: id, content: `sent to ${to}` }]),
];

test("older transcripts: a reply waits for the end of the run, past a report that continued the turn, until the user speaks", () => {
  const entries = transcript(
    meta,
    user(inbox(["user", "go"])),
    ...sentTo("r1", "user", "Started."),
    assistant([{ type: "text", text: "ok" }]), // end_turn
    user(inbox(["worker-a", "done"])), // a report arrives: the run goes on
    assistant([{ type: "text", text: "more text" }]),
    user(inbox(["user", "next"])),
    assistant([{ type: "text", text: "sure" }]),
  );
  const tool = { tool: "message(user: Started.)", summary: "sent to user", failed: false };
  expect(restore(entries, 60)).toEqual([
    { user: `${bold(">")} go` }, tool, { md: "ok", block: true }, dim("from worker-a: done"), { md: "more text", block: true },
    replyLine("orchestrator", "Started."),
    { user: `${bold(">")} next` }, { md: "sure", block: true },
  ]);
});

test("replies entries place what a turn sent the user (agents' too) after it; message calls before them are not shown twice", () => {
  const entries = transcript(
    meta,
    user(inbox(["user", "go"])),
    ...sentTo("r1", "user", "Started."),
    assistant([{ type: "text", text: "ok" }]),
    user(inbox(["worker-a", "done"])),
    assistant([{ type: "text", text: "more text" }]),
    { type: "replies", messages: [{ from: "orchestrator", text: "Started." }, { from: "worker-a", text: "hi user" }] } as never,
    // A turn started by a report alone: its reply shows after it, not when the user next speaks.
    user(inbox(["reviewer-a", "lgtm"])),
    ...sentTo("r2", "user", "Reviewed."),
    assistant([{ type: "text", text: "noted" }]),
    { type: "replies", messages: [{ from: "orchestrator", text: "Reviewed." }] } as never,
    user(inbox(["user", "thanks"])),
  );
  const lines = restore(entries, 60);
  expect(lines.filter((l) => typeof l !== "string" && "label" in l && l.label)).toEqual([replyLine("orchestrator", "Started."), replyLine("worker-a", "hi user"), replyLine("orchestrator", "Reviewed.")]);
  const at = (l: Line) => lines.findIndex((x) => JSON.stringify(x) === JSON.stringify(l));
  expect(at(replyLine("orchestrator", "Started."))).toBe(at({ md: "more text", block: true }) + 1);
  expect(at(replyLine("orchestrator", "Reviewed."))).toBe(at({ md: "noted", block: true }) + 1);
  expect(lines.at(-1)).toEqual({ user: `${bold(">")} thanks` });
});

test("a capped history that began at a summary drops the summary note and counts only messages", () => {
  const items = [meta as never, user(inbox(["user", "old"])), { type: "summary", text: "s", parentUuid: "u1" } as never];
  for (let i = 0; i < 120; i++) items.push(user(inbox(["user", `q${i}`])), assistant([{ type: "text", text: `a${i}` }]));
  const lines = restore(transcript(...items), 60);
  // Note plus 99 one-row messages and their separators: 199 rows; 141 messages omitted.
  expect(lines.length).toBe(100);
  expect(lines[0]).toBe(earlier(141));
  expect(lines.some((l) => raw(l).includes("old"))).toBe(false);
  // Metadata stays out of short histories too.
  const few = restore(transcript(meta, { type: "summary", text: "s" } as never, user(inbox(["user", "q"]))), 60);
  expect(few).toEqual([{ user: `${bold(">")} q` }]);
});

test("report lines cut at 100 characters, not UTF-16 units", () => {
  const emoji = "😀".repeat(150);
  const line = restore(transcript(meta, user(inbox(["worker-a", emoji]))), 60)[0] as string;
  expect(line).toBe(dim(`from worker-a: ${"😀".repeat(100)}…`));
  const exact = restore(transcript(meta, user(inbox(["worker-a", "😀".repeat(100)]))), 60)[0];
  expect(exact).toBe(dim(`from worker-a: ${"😀".repeat(100)}`));
});

test("tags inside a report or a user message are not senders", () => {
  const entries = transcript(meta, user(inbox(["worker-a", "Report\n\n[x] done\n\n[1] item"], ["user", "list:\n\n[x] done\n\n[1] item"])));
  expect(restore(entries, 60)).toEqual([...[`${bold(">")} list:`, "  ", "  [x] done", "  ", "  [1] item"].map((user) => ({ user })), dim("from worker-a: Report…")]);
});

test("settled questions leave no line: answers and legacy delivered skips are left out of the restored page, chat that merely looks like one is not", () => {
  const id = "2026-01-02T03-04-05.678Z-000007-0123abcd";
  const entries = transcript(
    meta,
    user("go"),
    assistant("Which db?"),
    user(inbox(
      ["user", `[${id}] answer to "Use \"a\": or (b)?": say "x": y`],
      ["user", '[2026-01-01T00-00-00.000Z-000002-abcd1234] skipped "Port?"; use your default (8080)'],
      ["user", '[2026-01-01T00-00-00.000Z-000003-abcd1234] skipped "Name?" (no default given); decide yourself'],
      ["user", "[not a question] hello"],
      ["worker-a", "done"],
    )),
    assistant("Noted."),
  );
  expect(restore(entries, 80).map(raw)).toEqual([`${bold(">")} go`, "Which db?", `${bold(">")} [not a question] hello`, dim("from worker-a: done"), "Noted."]);
  // The reply still counts as the user speaking: a held legacy reply to the user is released by it, and it is not an omitted "earlier message".
  const replyOnly = transcript(meta, user(inbox(["user", `[${id}] answer to "Which db?": postgres`])), assistant("Noted."));
  expect(restoreItems(replyOnly).map(item => item.lines().map(raw))).toEqual([["Noted."]]);
  expect(restore(replyOnly, 80, 1).map(raw)).toEqual(["Noted."]);
  // Only questions.ts's id shape counts, and only one line.
  expect(questionReply(`[${id}] answer to "a": b`)).toBe(true);
  expect(questionReply(`[${id}] skipped "a" (no default given); decide yourself`)).toBe(true);
  expect(questionReply('[q1] answer to "a": b')).toBe(false);
  expect(questionReply(`[${id}] answer to "a": b\nmore`)).toBe(false);
  expect(questionReply("plain")).toBe(false);
  expect(questionReply("? Approval? → skipped, removed from inbox")).toBe(false);
});

test("live and replay keep mixed-case user, assistant/code, paths, URLs, tool arguments and raw results", () => {
  const userText = "Keep MyInput APIKey /Users/Ada/Repo https://Host/Case";
  const reply = "# LLM Reply\n\n```ts\nconst APIKey = 'MiXeD';\n```";
  const command = "cat /Users/Ada/Repo/README.md";
  const result = "RAW Failure: HTTP 404 https://Host/Case";
  const entries = transcript(meta, user(inbox(["user", userText])),
    assistant([{ type: "text", text: reply }, { type: "tool_use", id: "case-tool", name: "bash", input: { command } }]),
    user([{ type: "tool_result", tool_use_id: "case-tool", content: result, is_error: true }]));
  const lines = restore(entries, 120);
  const restored = lines.map(raw).join("\n");
  for (const text of [userText, "LLM Reply", "const APIKey = 'MiXeD';", command, result]) expect(restored).toContain(text);
  const live = toolView("bash", { command }, { ok: false, text: result });
  expect(lines.find(line => typeof line !== "string" && "tool" in line)).toEqual(live);
  expect(live).toEqual({ tool: `bash(${command})`, summary: result, failed: true });
  const rendered = lines.flatMap(line => lineRows(line, 120)).map(Bun.stripANSI).join("\n");
  for (const text of [userText, "LLM Reply", "const APIKey = 'MiXeD';", command, result]) expect(rendered).toContain(text);
});
