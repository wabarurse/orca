import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { metered, recordRetry, usageScope } from "./usage";
import { usageEvent } from "../config";
import { fakeProvider, text } from "../test/fake-provider";
import { ModelRequestError } from "./errors/bounded-request";
import { z } from "zod";
const logLine = z.object({ kind: z.string() });
const parseLine = (line: string): unknown => JSON.parse(line);
let home = "", prior: string | undefined;
afterEach(async () => { if (prior === undefined) delete process.env.ORCA2_HOME; else process.env.ORCA2_HOME = prior; if (home !== "") await rm(home, { recursive: true, force: true }); });
test("accounting includes foreground, summaries, tools, search and retries without recording payloads", async () => {
  prior = process.env.ORCA2_HOME; home = await mkdtemp(join(tmpdir(), "orca-usage-")); process.env.ORCA2_HOME = home;
  const fake = fakeProvider([[text("private response")]]), original = fake.complete;
  fake.complete = async request => { recordRetry("anthropic", { attempt: 1, reason: "timeout" }); return { ...await original(request), inputTokens: 100, usage: { input: 100, cachedInput: 40, output: 10 } }; };
  const provider = metered({ ...fake, search: async () => ({ sources: [] }) });
  await provider.complete({ trace: { project: "p", agent: "orchestrator", purpose: "rolling-summary" }, model: "test", messages: [{ role: "user", content: "private prompt" }], tools: [], maxTokens: 10, onText() {} });
  const search = provider.search;
  if (search === undefined) throw new Error("metered provider lost search");
  await usageScope({ project: "p", agent: "worker-x" }, () => search({ model: "test", query: "private query", maxResults: 1, signal: new AbortController().signal }));
  await usageEvent({ kind: "tool", project: "p", tool: "read", durationMs: 5 });
  const log = await readFile(join(home, "usage.jsonl"), "utf8");
  const kinds = log.trim().split("\n").map(line => logLine.parse(parseLine(line)).kind);
  expect(kinds.filter(kind => kind === "model").length).toBe(2);
  expect(kinds).toContain("retry");
  const model = z.object({ build: z.string(), toolCalls: z.literal(0) }).safeParse(parseLine(log.trim().split("\n").find(line => line.includes('"kind":"model"')) ?? "null"));
  expect(model.success).toBe(true);
  expect(log).not.toContain("private"); expect(log).toContain("rolling-summary"); expect(log).toContain("web-search");
});

test("failure diagnostics identify the selected account and HTTP status without exposing payloads", async () => {
  prior = process.env.ORCA2_HOME; home = await mkdtemp(join(tmpdir(), "orca-usage-error-")); process.env.ORCA2_HOME = home;
  const provider = metered({ ...fakeProvider([]), account: "anthropic:personal", complete: async () => { throw new ModelRequestError("exhausted", 429); } });
  await expect(provider.complete({ model: "test", messages: [], tools: [], maxTokens: 10, onText() {} })).rejects.toThrow("anthropic:personal: Provider rate limit");
  const events = (await readFile(join(home, "usage.jsonl"), "utf8")).trim().split("\n").map(parseLine);
  expect(events[0]).toMatchObject({ account: "anthropic:personal", errorKind: "exhausted", errorReason: "rate-limit", httpStatus: 429, ok: false });
});

test("account-specific authentication guidance survives metering", async () => {
  prior = process.env.ORCA2_HOME; home = await mkdtemp(join(tmpdir(), "orca-usage-auth-")); process.env.ORCA2_HOME = home;
  const provider = metered({ ...fakeProvider([]), account: "openai:work", complete: async () => { throw new ModelRequestError("permanent", 401, "authentication"); } });
  await expect(provider.complete({ model: "test", messages: [], tools: [], maxTokens: 10, onText() {} })).rejects.toThrow("Sign in again with: orca2 login openai work");
});
