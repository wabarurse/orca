import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "./transcript";
import { follow, parts, render } from "./view";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const home = mkdtempSync(join(tmpdir(), "orca-view-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("render shows prompts, text, tool calls and results, and hides thinking", () => {
  expect(strip(render({ uuid: "1", parentUuid: null, ts: "", type: "meta", role: "worker", branch: "feat/x", model: "m" })!)).toBe("— worker on feat/x (m)");
  expect(strip(render({ uuid: "2", parentUuid: null, ts: "", type: "message", message: { role: "user", content: "do it" } })!)).toBe("> do it");
  const assistant = render({
    uuid: "3", parentUuid: null, ts: "", type: "message",
    message: { role: "assistant", content: [
      { type: "thinking", thinking: "secret", signature: "" },
      { type: "text", text: "on it" },
      { type: "tool_use", id: "t", name: "bash", input: { command: "ls\n-la" } },
    ] },
  })!;
  expect(strip(assistant)).toBe("on it\n⏺ bash(ls -la)");
  const result = render({
    uuid: "4", parentUuid: null, ts: "", type: "message",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "a.ts\nb.ts", is_error: true }] },
  })!;
  expect(strip(result)).toBe("  ⎿  a.ts");
});

test("follow prints history, then new entries, then stops", async () => {
  const path = join(home, "t.jsonl");
  const t = open(path);
  await t.append({ type: "message", message: { role: "user", content: "first" } });

  const lines: string[] = [];
  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  const running = follow(path, (s) => lines.push(strip(s)), stopped, 20);

  await Bun.sleep(60);
  expect(lines).toEqual(["> first"]);
  await t.append({ type: "message", message: { role: "assistant", content: "second" } });
  await Bun.sleep(60);
  expect(lines).toEqual(["> first", "second"]);
  stop();
  await running;
});

test("parts keeps assistant text as markdown, tool calls and results as parts to pair, and the rest as styled lines", () => {
  const ps = parts({
    uuid: "5", parentUuid: null, ts: "", type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "**hi**" }, { type: "tool_use", id: "t", name: "bash", input: {} }] },
  })!;
  expect(ps[0]).toEqual({ md: "**hi**" });
  expect(ps[1]).toEqual({ call: { id: "t", name: "bash", input: {} } });
  expect(parts({ uuid: "6", parentUuid: null, ts: "", type: "message", message: { role: "user", content: "**raw**" } })!.map((p) => strip(p as string))).toEqual(["> **raw**"]);
});

test("a replies entry shows each message to the user with its sender", () => {
  const ps = parts({ uuid: "r", parentUuid: null, ts: "", type: "replies", messages: [{ from: "orchestrator", text: "**done**" }] });
  expect(ps).toEqual(["\x1b[2morchestrator → user:\x1b[0m", { md: "**done**" }]);
});
