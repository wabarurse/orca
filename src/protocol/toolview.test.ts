import { expect, test } from "bun:test";
import { toolLabel, toolSummary, toolView, capped, callText, resultText } from "./toolview";

test("labels: a short human summary of the input per tool, the first string argument otherwise", () => {
  expect(toolLabel("bash", { command: "git status" })).toBe("bash(git status)");
  expect(toolLabel("bash", { command: "cd x &&\n  make   test" })).toBe("bash(cd x && make test)");
  expect(toolLabel("message", { to: "orchestrator", text: "Done: all tests pass and the PR is open now, see below" })).toBe("message(orchestrator: Done: all tests pass and the PR is…)");
  expect(toolLabel("message", { to: "user", text: "hi" })).toBe("message(user: hi)");
  expect(toolLabel("spawn", { prompt: "long brief", branch: "feat/login" })).toBe("spawn(feat/login, worker)");
  expect(toolLabel("spawn", { prompt: "p", branch: "feat/x", role: "reviewer" })).toBe("spawn(feat/x, reviewer)");
  expect(toolLabel("ask", { questions: [{ text: "Which db?" }] })).toBe("ask(Which db?)");
  expect(toolLabel("ask", { questions: [{ text: "Which db?" }, { text: "Port?" }] })).toBe("ask(2 questions: Which db?)");
  expect(toolLabel("ask", { action: "list" })).toBe("ask(list)");
  expect(toolLabel("ask", { action: "close", ids: ["a", "b"], reason: "answered in chat" })).toBe("ask(close 2: answered in chat)");
  expect(toolLabel("fetch", { n: 3, url: "https://x.y\n" })).toBe("fetch(https://x.y)");
  expect(toolLabel("odd", null)).toBe("odd()");
  expect(toolLabel("bash", "not an object")).toBe("bash()");
});

test("summaries: bash line counts, exit codes with the first error line, timeouts; message and spawn; else the first line", () => {
  expect(toolSummary("bash", { ok: true, text: "a\nb\nc\n" })).toEqual({ summary: "3 lines", failed: false });
  expect(toolSummary("bash", { ok: true, text: "one" })).toEqual({ summary: "1 line", failed: false });
  expect(toolSummary("bash", { ok: true, text: "" })).toEqual({ summary: "no output", failed: false });
  expect(toolSummary("bash", { ok: true, text: "building\nsrc/x.ts: error TS2304: nope\nmore\n[exit 2]" })).toEqual({ summary: "exit 2: src/x.ts: error TS2304: nope", failed: true });
  expect(toolSummary("bash", { ok: true, text: "\n  first\nsecond\n[exit 1]" })).toEqual({ summary: "exit 1: first", failed: true });
  expect(toolSummary("bash", { ok: true, text: "[exit 127]" })).toEqual({ summary: "exit 127", failed: true });
  expect(toolSummary("bash", { ok: true, text: "x\n[timed out after 600s]\n[exit 143]" })).toEqual({ summary: "timed out after 600s", failed: true });
  expect(toolSummary("bash", { ok: true, text: "refused: not allowed" })).toEqual({ summary: "1 line", failed: false });
  expect(toolSummary("message", { ok: true, text: "sent to orchestrator" })).toEqual({ summary: "sent to orchestrator", failed: false });
  expect(toolSummary("message", { ok: true, text: "refused: empty message" })).toEqual({ summary: "refused: empty message", failed: true });
  expect(toolSummary("spawn", { ok: true, text: "worker-feat-login" })).toEqual({ summary: "spawned worker-feat-login", failed: false });
  expect(toolSummary("bash", { ok: false, text: "boom\nstack" })).toEqual({ summary: "boom", failed: true });
  expect(toolSummary("x", { ok: false, text: "" })).toEqual({ summary: "error", failed: true });
  expect(toolSummary("x", { ok: true, text: "" })).toEqual({ summary: "done", failed: false });
  expect(toolView("bash", { command: "ls" }, { ok: true, text: "a\n" })).toEqual({ tool: "bash(ls)", summary: "1 line", failed: false });
});

test("untrusted tool inputs and results are plain, stdout is display-width capped", () => {
  const attack = "\x1b[31mred\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07\x1b]52;c;evil\x1b\\";
  expect(toolLabel("bash", { command: attack })).toBe("bash(red link)");
  expect(toolSummary("message", { ok: true, text: attack }).summary).toBe("red link");
  expect(callText({ name: "bash", input: { command: attack.repeat(100) } })).not.toContain("\x1b");
  expect(Bun.stringWidth(capped("你好".repeat(200)))).toBeLessThanOrEqual(200);
  expect(resultText("message", { ok: true, text: attack.repeat(100) })).not.toContain("\x1b");
});
test("bash heuristics only recognize terminal markers, skip zero errors, and report truncation", () => {
  expect(toolSummary("bash", { ok: true, text: "[timed out after 2s]\nstill here" })).toEqual({ summary: "2 lines", failed: false });
  expect(toolSummary("bash", { ok: true, text: "a\nb\n...[truncated 123 bytes]...\nc\n" }).summary).toBe("3+ lines (truncated)");
  expect(toolSummary("bash", { ok: true, text: "error: old\n0 failed\nerror: latest\nno errors\n[exit 1]" }).summary).toBe("exit 1: error: latest");
});

test("saved output footers preserve timeout and exit failure summaries", () => {
  expect(toolSummary("bash", { ok: true, text: "connecting\n[timed out after 0.25s; saved output is incomplete]\n[exit 137]\n[partial output: /tmp/output.partial]" }))
    .toEqual({ summary: "timed out after 0.25s", failed: true });
  expect(toolSummary("bash", { ok: true, text: "[timed out after 1s; saved output is incomplete]\n[partial output: /tmp/output.partial]" }))
    .toEqual({ summary: "timed out after 1s", failed: true });
  expect(toolSummary("bash", { ok: true, text: "error: connection closed\n[exit 2]\n[full output: /tmp/output.txt]" }))
    .toEqual({ summary: "exit 2: error: connection closed", failed: true });
  expect(toolSummary("bash", { ok: true, text: "[timed out after 1s; saved output is incomplete]\nstill here\n[full output: /tmp/output.txt]" }).failed).toBe(false);
});

test("lowercase owned tool labels do not normalize unknown identifiers, values or raw output", () => {
  expect(toolLabel("web_search", { query: "HTTP API CamelCase" })).toBe("websearch(HTTP API CamelCase)");
  expect(toolLabel("CustomTool", { path: "/Users/Ada/Repo/README.md" })).toBe("CustomTool(/Users/Ada/Repo/README.md)");
  expect(toolSummary("CustomTool", { ok: true, text: "RAW ToolOutput https://Host/Path\nMore Text" }).summary).toBe("RAW ToolOutput https://Host/Path");
  expect(toolLabel("message", { to: "Reviewer-MixedCase", text: "Please Keep THIS" })).toBe("message(Reviewer-MixedCase: Please Keep THIS)");
});

test("history calls show the action with the query, or the entry being read", () => {
  expect(toolLabel("history", { action: "search", query: "login redesign" })).toBe("history(search login redesign)");
  expect(toolLabel("history", { action: "search" })).toBe("history(search)");
  expect(toolLabel("history", { action: "read", project: "alpha", entryId: "e1" })).toBe("history(read alpha/e1)");
  expect(toolSummary("history", { ok: true, text: "refused: only the orchestrator can query archived history" })).toEqual({ summary: "refused: only the orchestrator can query archived history", failed: true });
  expect(toolSummary("history", { ok: true, text: '{"entries":[]}' }).failed).toBe(false);
});
