import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../agent";
import { compact } from "../compaction";
import { createOrchestrator } from "../orchestrator";
import { claudeMessages } from "../providers/anthropic";
import { toResponses } from "../providers/openai";
import { claudeSearchResults, codexSearchResults } from "../providers/search-results";
import { searchText, type SearchRequest } from "../providers/web-search";
import { fakeProvider, text, toolUse } from "../test/fake-provider";
import { claudeSearchFixture, codexSearchFixture } from "../test/web-search";
import { open, type Role } from "../transcript";
import { restore } from "../tui/restore";
import { registry, toolsFor } from "./index";
import { web_search } from "./web-search";

const oldHome = process.env.PARALLELS_HOME;
const dirs: string[] = [];
afterEach(() => { process.env.PARALLELS_HOME = oldHome; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "parallels-search-")); dirs.push(dir);
  process.env.PARALLELS_HOME = dir;
  return { dir, transcript: open(join(dir, "test.jsonl")) };
}

for (const role of ["orchestrator", "worker", "reviewer"] as Role[]) test(`${role} executes the same tool on its request snapshot, then can switch providers`, async () => {
  const { dir, transcript } = fixture();
  await transcript.append({ type: "message", message: { role: "user", content: "research public docs; private task must not enter search" } });
  let searches = 0;
  let sent!: SearchRequest;
  const original = { ...fakeProvider([[toolUse("s1", "web_search", { query: "public docs" })]]), search: async (req: SearchRequest) => {
    searches++; sent = req; return claudeSearchResults(claudeSearchFixture());
  } };
  const next = { ...fakeProvider([[text("See https://example.com/docs")]]), name: "openai" as const, search: async () => { throw new Error("must not change provider mid-tool"); } };
  let resolutions = 0;
  const tools = Object.fromEntries(toolsFor[role].map(name => [name, registry[name]!]));
  await createAgent({ transcript, model: "unused-model", tools, ctx: { project: "p", role, cwd: dir }, write() {},
    resolveModel: async () => ++resolutions === 1
      ? { model: "claude-opus-5", provider: original, settings: { effort: "high" } }
      : { model: "gpt-6-astra", provider: next, settings: { effort: "low" } },
  }).run();
  expect(resolutions).toBe(2); expect(searches).toBe(1);
  expect(sent).toMatchObject({ model: "claude-opus-5", settings: { effort: "high" }, query: "public docs" });
  expect(Object.keys(sent)).not.toContain("messages");
  expect(original.calls[0]!.tools).toEqual(toolsFor[role]);
  const result = next.calls[0]!.messages[2]!.content;
  expect(result).toMatchObject([{ type: "tool_result", tool_use_id: "s1" }]);
  expect(JSON.stringify(result)).toContain("An actual quoted excerpt.");
  const restored = open(transcript.path);
  expect(await restored.chain()).toEqual(await transcript.chain());
  const codexHistory = toResponses(await restored.chain());
  expect(JSON.stringify(codexHistory)).toContain("https://example.com/docs");
  expect(JSON.stringify(codexHistory)).not.toContain("opaque-");
  expect(JSON.stringify(claudeMessages(await restored.chain()))).toContain("An actual quoted excerpt.");
  expect(JSON.stringify(restore(restored.history!(), 100))).toContain("WebSearch(public docs)");
  expect(JSON.stringify(restore(restored.history!(), 100))).toContain("Web search: 2 sources.");
});

test("production orchestrator default allowlist exposes the sixth tool without overrides", async () => {
  fixture();
  const provider = { ...fakeProvider([[toolUse("s1", "web_search", { query: "public docs" })], [text("done")]]),
    search: async () => codexSearchResults(codexSearchFixture()) };
  const orchestrator = await createOrchestrator({ project: "p", provider, write() {} });
  await orchestrator.say("search public docs"); await orchestrator.turn();
  expect(provider.calls[0]!.tools).toEqual(toolsFor.orchestrator);
  expect(JSON.stringify(provider.calls[1]!.messages)).toContain("https://example.com/docs");
});

test("search failure is a paired is_error tool result with no raw credential error", async () => {
  const { dir, transcript } = fixture();
  await transcript.append({ type: "message", message: { role: "user", content: "search" } });
  const provider = { ...fakeProvider([[toolUse("s1", "web_search", { query: "docs" })], [text("unavailable")]]),
    search: async () => { throw new Error("Bearer SECRET error from server"); } };
  await createAgent({ transcript, provider, model: "m", tools: { web_search }, ctx: { project: "p", role: "worker", cwd: dir }, write() {} }).run();
  expect(provider.calls[1]!.messages[2]!.content).toMatchObject([{ type: "tool_result", tool_use_id: "s1", is_error: true }]);
  expect(await Bun.file(transcript.path).text()).not.toContain("SECRET");
});

test("compaction keeps complete original search attribution on disk/UI and retained batches across provider translation", async () => {
  const { dir, transcript } = fixture();
  await transcript.append({ type: "message", message: { role: "user", content: "original task" } });
  await transcript.append({ type: "message", message: { role: "assistant", content: "old history ".repeat(3000) } });
  const result = searchText(claudeSearchResults(claudeSearchFixture()), 5);
  await transcript.append({ type: "message", message: { role: "user", content: "research docs" } });
  await transcript.append({ type: "message", message: { role: "assistant", content: [toolUse("s1", "web_search", { query: "public docs" })] } });
  await transcript.append({ type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: result }] } });
  await transcript.append({ type: "message", message: { role: "assistant", content: "See https://example.com/docs" } });
  const original = transcript.history!();
  const summary = fakeProvider([[text("Original task; older history condensed.")]]);
  const deps = { transcript, provider: summary, model: "m", tools: { web_search }, ctx: { project: "p", role: "worker" as const, cwd: dir }, compaction: { contextLimit: 100000 } };
  expect(await compact(deps, true)).toBe(true);
  const restored = open(transcript.path);
  expect(restored.history!()).toEqual(original);
  expect(JSON.stringify(await restored.chain())).toContain("An actual quoted excerpt.");
  expect(JSON.stringify(toResponses(await restored.chain()))).toContain("https://example.com/docs");
  expect(JSON.stringify(claudeMessages(await restored.chain()))).toContain("https://example.org/guide");
  expect(restore(restored.history!(), 100)).toEqual(restore(original, 100));

  // When even the search batch becomes old, summaries are deliberately lossy,
  // but the original sources/results must still survive untouched on disk/UI.
  await transcript.append({ type: "message", message: { role: "user", content: "next large task ".repeat(3000) } });
  await transcript.append({ type: "message", message: { role: "assistant", content: "done" } });
  await transcript.append({ type: "message", message: { role: "user", content: "newest task" } });
  deps.provider = fakeProvider([[text("Prior research: https://example.com/docs. Next: newest task.")]]);
  const history = transcript.history!();
  expect(await compact(deps, true)).toBe(true);
  expect(open(transcript.path).history!()).toEqual(history);
  expect(await Bun.file(transcript.path).text()).toContain("An actual quoted excerpt.");
});
