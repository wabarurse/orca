import { expect, test } from "bun:test";
import { toolLabel, toolSummary, toolView } from "./toolview";

test("labels: a short human summary of the input per tool, the first string argument otherwise", () => {
  expect(toolLabel("bash", { command: "git status" })).toBe("Bash(git status)");
  expect(toolLabel("bash", { command: "cd x &&\n  make   test" })).toBe("Bash(cd x && make test)");
  expect(toolLabel("message", { to: "orchestrator", text: "Done: all tests pass and the PR is open now, see below" })).toBe("Message(orchestrator: Done: all tests pass and the PR is…)");
  expect(toolLabel("message", { to: "user", text: "hi" })).toBe("Message(user: hi)");
  expect(toolLabel("spawn", { prompt: "long brief", branch: "feat/login" })).toBe("Spawn(feat/login, worker)");
  expect(toolLabel("spawn", { prompt: "p", branch: "feat/x", role: "reviewer" })).toBe("Spawn(feat/x, reviewer)");
  expect(toolLabel("complexity", { files: ["src/a.ts", "src/b.ts"] })).toBe("Complexity(src/a.ts, src/b.ts)");
  expect(toolLabel("complexity", {})).toBe("Complexity(changed files)");
  expect(toolLabel("complexity", { base: "main" })).toBe("Complexity(changed files vs main)");
  expect(toolLabel("ask", { questions: [{ text: "Which db?" }] })).toBe("Ask(Which db?)");
  expect(toolLabel("ask", { questions: [{ text: "Which db?" }, { text: "Port?" }] })).toBe("Ask(2 questions: Which db?)");
  expect(toolLabel("fetch", { n: 3, url: "https://x.y\n" })).toBe("Fetch(https://x.y)");
  expect(toolLabel("odd", null)).toBe("Odd()");
  expect(toolLabel("bash", "not an object")).toBe("Bash()");
});

test("summaries: bash line counts, exit codes with the first error line, timeouts; message and spawn; else the first line", () => {
  expect(toolSummary("bash", { ok: true, text: "a\nb\nc\n" })).toEqual({ summary: "3 lines", failed: false });
  expect(toolSummary("bash", { ok: true, text: "one" })).toEqual({ summary: "1 line", failed: false });
  expect(toolSummary("bash", { ok: true, text: "" })).toEqual({ summary: "no output", failed: false });
  expect(toolSummary("bash", { ok: true, text: "building\nsrc/x.ts: error TS2304: nope\nmore\n[exit 2]" })).toEqual({ summary: "exit 2: src/x.ts: error TS2304: nope", failed: true });
  expect(toolSummary("bash", { ok: true, text: "\n  first\nsecond\n[exit 1]" })).toEqual({ summary: "exit 1: first", failed: true });
  expect(toolSummary("bash", { ok: true, text: "[exit 127]" })).toEqual({ summary: "exit 127", failed: true });
  expect(toolSummary("bash", { ok: true, text: "x\n[timed out after 600s]\n[exit 143]" })).toEqual({ summary: "timed out after 600s", failed: true });
  expect(toolSummary("bash", { ok: true, text: "refused: not allowed" })).toEqual({ summary: "refused: not allowed", failed: true });
  expect(toolSummary("message", { ok: true, text: "sent to orchestrator" })).toEqual({ summary: "sent to orchestrator", failed: false });
  expect(toolSummary("message", { ok: true, text: "refused: empty message" })).toEqual({ summary: "refused: empty message", failed: true });
  expect(toolSummary("spawn", { ok: true, text: "worker-feat-login" })).toEqual({ summary: "spawned worker-feat-login", failed: false });
  expect(toolSummary("complexity", { ok: true, text: "\n| file | fn |\n…" })).toEqual({ summary: "| file | fn |", failed: false });
  expect(toolSummary("bash", { ok: false, text: "boom\nstack" })).toEqual({ summary: "boom", failed: true });
  expect(toolSummary("x", { ok: false, text: "" })).toEqual({ summary: "error", failed: true });
  expect(toolSummary("x", { ok: true, text: "" })).toEqual({ summary: "done", failed: false });
  expect(toolView("bash", { command: "ls" }, { ok: true, text: "a\n" })).toEqual({ tool: "Bash(ls)", summary: "1 line", failed: false });
});
