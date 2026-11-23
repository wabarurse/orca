import { expect, test } from "bun:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { paired, pairResults } from "./pairs";

const use: MessageParam = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] };
const result: MessageParam = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "interrupted" }] };

test("a tool result written after newer input moves back right after its call, and the input follows it", () => {
  const broken: MessageParam[] = [{ role: "user", content: "[user] go" }, use, { role: "user", content: "[user] hi" }, result, { role: "user", content: "[user] hi again" }];
  expect(paired(broken)).toBe(false);
  const fixed = pairResults(broken);
  expect(paired(fixed)).toBe(true);
  expect(fixed).toEqual([{ role: "user", content: "[user] go" }, use, { role: "user", content: result.content }, { role: "user", content: "[user] hi" }, { role: "user", content: "[user] hi again" }]);
});

test("a history that is already in order, or still waiting for its results, is left exactly as it is", () => {
  const good: MessageParam[] = [{ role: "user", content: "go" }, use, { role: "user", content: [...(typeof result.content === "string" ? [] : result.content), { type: "text", text: "[user] hi" }] }];
  expect(pairResults(good)).toBe(good);
  const waiting: MessageParam[] = [{ role: "user", content: "go" }, use];
  expect(pairResults(waiting)).toEqual(waiting);
});
