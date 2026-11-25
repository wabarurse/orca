import { expect, test } from "bun:test";
import { createConversation, readConversation } from "./conversations";
import { requestSettings } from "./session";
import { tempHome } from "../test/home";
import { effortChoices, fastChoices, recentModels, setEffort, setFast, setModel } from "./settings";

const home = tempHome("settings");

test("choices mark the chat's current value, default when nothing is saved", () => {
  expect(effortChoices("claude-opus-5-5", null).filter(c => c.current).map(c => c.value)).toEqual(["default"]);
  expect(effortChoices("claude-opus-5-5", "high").filter(c => c.current).map(c => c.value)).toEqual(["high"]);
  expect(fastChoices(true).filter(c => c.current).map(c => c.label)).toEqual(["on"]);
  expect(recentModels(["a", "b", "c", "d", "e", "f", "g", "h"], "h")).toEqual(["a", "b", "c", "d", "e", "f", "h"]);
});

test("switching model keeps the effort and fast mode it supports and drops the rest", async () => {
  const chat = await createConversation(home.path(), null);
  const effort = await setEffort({ ...chat, model: "claude-opus-5-5" }, "xhigh");
  if (!effort.ok) throw new Error(effort.error);
  const tuned = await setFast(effort.data, true);
  if (!tuned.ok) throw new Error(tuned.error);
  const kept = await setModel(tuned.data, "claude-fable-5");
  expect(kept.ok && { effort: kept.data.effort, fast: kept.data.fast }).toEqual({ effort: "xhigh", fast: false });
  const moved = await setModel(tuned.data, "claude-sonnet-4-6");
  expect(moved.ok && { effort: moved.data.effort, fast: moved.data.fast }).toEqual({ effort: null, fast: false });
  expect((await readConversation(chat.id))?.model).toBe("claude-sonnet-4-6");
  expect((await setFast({ ...chat, model: "claude-sonnet-4-6" }, true)).ok).toBe(false);
});

test("each request sends the chat's effort and fast mode when the model supports them", () => {
  expect(requestSettings("claude-opus-5-5", "high", true)).toEqual({ effort: "high", fast: true });
  expect(requestSettings("claude-opus-5-5", null, false)).toBeNull();
  expect(requestSettings("claude-sonnet-5-5", "high", true)).toEqual({ effort: "high" });
});
