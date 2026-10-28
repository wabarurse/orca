import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../config";
import { facts, recordCorrection } from "../data/knowledge";
import { open } from "../data/transcripts";
import type { ToolContext } from "./registry";
import { rememberTool } from "./remember";

// Isolated ORCA_HOME per test: never the real home.
let home: string, previous: string | undefined;
const ctx: ToolContext = { project: "mem", role: "orchestrator", cwd: "/" };
beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  home = await mkdtemp(join(tmpdir(), "orca-remember-")); process.env.ORCA_HOME = home;
  await mkdir(paths.project("mem"), { recursive: true });
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  await rm(home, { recursive: true, force: true });
});

const save = (source: unknown, extra: Record<string, unknown> = {}) =>
  rememberTool.run({ action: "save", scope: "user", key: "ui.mockups", text: "Use mockup-pick for UI options", confidence: "explicit", ...(source === undefined ? {} : { source }), ...extra }, ctx);
const saved = async () => (await facts("mem", "user")).find(f => f.key === "ui.mockups");

test("an exact retained id still resolves, storing the id and a short quote", async () => {
  await recordCorrection("mem", { id: "input-1", text: "Use the mockup-pick skill for UI choices", at: "2026-10-28T10:00:00.000Z" });
  expect(await save("input-1")).toBe('saved user knowledge ui.mockups (human-sourced interpretation of input-1: "Use the mockup-pick skill for UI choices")');
  expect(await saved()).toMatchObject({ source: "input-1", quote: "Use the mockup-pick skill for UI choices", confidence: "explicit" });
});

test("a free-text source quoting a human message older than the brief's last three resolves to its canonical id", async () => {
  await recordCorrection("mem", { id: "input-old", text: "wheres the mockup? did you load the /mockup-pick skill in the .claude?", at: "2026-10-28T10:00:00.000Z" });
  for (const n of [1, 2, 3]) await recordCorrection("mem", { id: `input-new-${n}`, text: `unrelated ${n}`, at: `2026-10-28T11:0${n}:00.000Z` });
  expect(await save('User, 2026-10-28: "did you load the /mockup-pick skill"')).toContain("human-sourced interpretation of input-old");
  expect(await saved()).toMatchObject({ source: "input-old", quote: "did you load the /mockup-pick skill", confidence: "explicit" });
  // Curly quotes, an ellipsis and different case still match; a source that contains the id does too.
  expect(await save("User: \u201cWHERES the mockup? \u2026 /mockup-pick skill\u201d")).toContain("input-old");
  expect(await save("user message input-old")).toContain("input-old");
});

test("user messages in the orchestrator transcript qualify; worker and assistant text never does", async () => {
  const t = open(paths.transcript("mem", "orchestrator"));
  await t.append({ type: "message", inbox: [{ from: "user", text: "always keep pull requests small and focused", ts: "2026-10-27T09:00:00.000Z", inputId: "typed-1", deliveryId: "orchestrator/a.json" }],
    message: { role: "user", content: "[user] always keep pull requests small and focused" } });
  await t.append({ type: "message", inbox: [{ from: "worker-x", text: "the user prefers tabs over spaces everywhere", ts: "2026-10-27T09:01:00.000Z", deliveryId: "orchestrator/b.json" }],
    message: { role: "user", content: "[worker-x] the user prefers tabs over spaces everywhere" } });
  await t.append({ type: "message", message: { role: "assistant", content: "I will always use dark mode for the user" } });
  expect(await save('"keep pull requests small"')).toContain("typed-1");
  await expect(save('"the user prefers tabs over spaces"')).rejects.toThrow("names or quotes none");
  await expect(save('"always use dark mode for the user"')).rejects.toThrow("names or quotes none");
  await expect(save("orchestrator/b.json")).rejects.toThrow("names or quotes none");
});

test("a Questions answer counts by its answer only, never the assistant's quoted question", async () => {
  await recordCorrection("mem", { id: "answer-1", text: '[q-1] answer to "Should every PR include screenshots of the change?": yes, for UI changes only', at: "2026-10-28T10:00:00.000Z" });
  expect(await save('"yes, for UI changes only"')).toContain("answer-1");
  await expect(save('"Should every PR include screenshots"')).rejects.toThrow("names or quotes none");
});

test("an unresolvable source fails listing recent human message ids with previews; short or paraphrased quotes do not match", async () => {
  await recordCorrection("mem", { id: "input-a", text: "do not run bun test; it overwrote my config", at: "2026-10-28T10:00:00.000Z" });
  await recordCorrection("mem", { id: "input-b", text: "both of these are tool failures can you fix with pr", at: "2026-10-28T10:01:00.000Z" });
  const error: Error = await save('User, 2026-10-28: "please never run the tests"').then(() => new Error("saved"), (e: Error) => e);
  expect(error.message).toContain("Pass one of these ids as source");
  expect(error.message).toContain('- input-b (2026-10-28T10:01:00.000Z): "both of these are tool failures can you fix with pr"');
  expect(error.message).toContain('- input-a (2026-10-28T10:00:00.000Z): "do not run bun test; it overwrote my config"');
  expect(error.message.indexOf("input-b")).toBeLessThan(error.message.indexOf("input-a")); // newest first
  await expect(save('"bun test"')).rejects.toThrow("names or quotes none"); // too short to identify a message
  expect(await saved()).toBeUndefined();
});

test("explicit without a source uses the newest human message; with none retained it fails and says so", async () => {
  await expect(save(undefined)).rejects.toThrow("no human messages are retained for this project yet");
  await recordCorrection("mem", { id: "input-z", text: "prefer concise replies", at: "2026-10-28T10:00:00.000Z" });
  expect(await save(undefined)).toContain("input-z");
});

test("tentative saves keep their free-text source unchanged", async () => {
  expect(await save("assistant inference from the review", { confidence: "tentative" })).toBe("saved user knowledge ui.mockups (tentative)");
  expect(await saved()).toMatchObject({ source: "assistant inference from the review", confidence: "tentative" });
  expect((await saved())?.quote).toBeUndefined();
});

test("the description and source schema say what an explicit source must be", () => {
  expect(rememberTool.spec.description).toContain("names (by id) or quotes a real human message");
  const schema = rememberTool.spec.input_schema as { properties: { source: { description: string } } };
  expect(schema.properties.source.description).toContain("assistant, tool and worker text never qualify");
});
