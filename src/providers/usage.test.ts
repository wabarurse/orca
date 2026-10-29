import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { metered, recordRetry, usageEvent, usageScope } from "./usage";
import { usageSummary } from "../core/data/knowledge";
import { fakeProvider, text } from "../test/fake-provider";
import { ModelRequestError } from "./bounded-request";
let home: string, prior: string | undefined;
afterEach(async () => { if (prior === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = prior; if (home) await rm(home, { recursive: true, force: true }); });
test("accounting includes foreground, summaries, tools, search and retries without recording payloads", async () => {
  prior = process.env.ORCA_HOME; home = await mkdtemp(join(tmpdir(), "orca-usage-")); process.env.ORCA_HOME = home;
  const fake = fakeProvider([[text("private response")]]), original = fake.complete;
  fake.complete = async request => { recordRetry("anthropic", { attempt: 1, reason: "timeout" }); return { ...await original(request), inputTokens: 100, usage: { input: 100, cachedInput: 40, output: 10 } }; };
  const provider = metered({ ...fake, search: async () => ({ sources: [] }) });
  await provider.complete({ trace: { project: "p", agent: "orchestrator", purpose: "rolling-summary" }, model: "test", messages: [{ role: "user", content: "private prompt" }], tools: [], maxTokens: 10, onText() {} });
  await usageScope({ project: "p", agent: "worker-x" }, () => provider.search!({ model: "test", query: "private query", maxResults: 1, signal: new AbortController().signal }));
  await usageEvent({ kind: "tool", project: "p", tool: "read", durationMs: 5 });
  const totals = await usageSummary("p");
  expect(totals).toMatchObject({ requests: 2, retries: 1, input: 100, cachedInput: 40, output: 10, usageMissing: 1, toolCalls: 1, peakContext: 100 });
  expect((await usageSummary("other")).requests).toBe(0);
  const log = await readFile(join(home, ".runtime/usage.jsonl"), "utf8");
  expect(log).not.toContain("private"); expect(log).toContain("rolling-summary"); expect(log).toContain("web-search");
});

test("failure diagnostics identify the selected account and HTTP status without exposing payloads", async () => {
  prior = process.env.ORCA_HOME; home = await mkdtemp(join(tmpdir(), "orca-usage-error-")); process.env.ORCA_HOME = home;
  const provider = metered({ ...fakeProvider([]), account: "anthropic:personal", complete: async () => { throw new ModelRequestError("exhausted", 429); } });
  await expect(provider.complete({ model: "test", messages: [], tools: [], maxTokens: 10, onText() {} })).rejects.toThrow("anthropic:personal: Model request exhausted (HTTP 429");
  const events = (await readFile(join(home, ".runtime/usage.jsonl"), "utf8")).trim().split("\n").map(s => JSON.parse(s));
  expect(events[0]).toMatchObject({ account: "anthropic:personal", errorKind: "exhausted", httpStatus: 429, ok: false });
});
