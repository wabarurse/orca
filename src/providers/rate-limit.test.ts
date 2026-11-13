import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { paths, readState, updateState } from "../config";
import { anthropic } from "./anthropic";
import { coordinatedTransport, lockoutUntil } from "./rate-limit";
const root = mkdtempSync(join(tmpdir(), "orca-rate-limit-"));
process.env.ORCA_HOME = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("a 429 delays another instance of the same account, without blocking another account", async () => {
  await coordinatedTransport("a", async () => new Response(null, { status: 429, headers: { "retry-after": "0.06" } }))("https://example.test");
  let called = false;
  const waiting = coordinatedTransport("a", async () => { called = true; return new Response("ok"); })("https://example.test");
  await coordinatedTransport("b", async () => new Response("ok"))("https://example.test");
  expect(called).toBe(false);
  await waiting; expect(called).toBe(true);
});
test("cancellation stops admission before making another HTTP request", async () => {
  await coordinatedTransport("cancel", async () => new Response(null, { status: 429, headers: { "retry-after": "5" } }))("https://example.test");
  const controller = new AbortController(); let calls = 0;
  const pending = coordinatedTransport("cancel", async () => { calls++; return new Response(); })("https://example.test", { signal: controller.signal });
  controller.abort(Error("user stopped"));
  await expect(pending).rejects.toThrow("user stopped"); expect(calls).toBe(0);
});
const locked = () => Response.json({ type: "error", error: { type: "rate_limit_error", message: "x" } }, { status: 429, headers: { "retry-after": "3600" } });
test("a lockout is never saved or waited for: every request asks the provider", async () => {
  let calls = 0;
  const ask = coordinatedTransport("long", async () => { calls++; return locked(); });
  for (let i = 0; i < 3; i++) expect((await ask("https://example.test")).status).toBe(429);
  expect(calls).toBe(3);
  expect((await coordinatedTransport("long", async () => new Response("ok"))("https://example.test")).ok).toBe(true);
});
test("a lockout saved by an older build is asked about, and a success clears it", async () => {
  const saved = () => readState(paths.memory, "provider-rate:old", "cooldown");
  updateState(paths.memory, "provider-rate:old", "cooldown", () => ({ until: Date.now() + 3600_000, probeAt: Date.now() + 3600_000, failures: 1, version: "v" }));
  expect((await coordinatedTransport("old", async () => locked())("https://example.test")).status).toBe(429);
  expect(saved()).toBeDefined();
  expect((await coordinatedTransport("old", async () => new Response("ok"))("https://example.test")).ok).toBe(true);
  expect(saved()).toBeUndefined();
});
test("a lockout is one request, reported as a rate limit with its end time", async () => {
  expect(lockoutUntil(new Response(null, { status: 429, headers: { "retry-after": "30" } }))).toBeUndefined();
  expect(lockoutUntil({ status: 429, headers: { "retry-after": "3600" } }, 1000)).toBe(3601000);
  expect(lockoutUntil({ status: 500, headers: { "retry-after": "3600" } })).toBeUndefined();
  let calls = 0;
  const transport = Object.assign(async () => { calls++; return locked(); }, { preconnect: fetch.preconnect });
  const provider = anthropic(new Anthropic({ apiKey: "test", fetch: transport }), { recovery: { enabled: true, account: "report", idleMs: 100, totalMs: 2000 }, retry: { backoffMs: [0, 0] } });
  const request = { model: "test", messages: [{ role: "user" as const, content: "hi" }], tools: [], maxTokens: 100, onText() {} };
  const error = await provider.complete(request).catch(error => error);
  expect(error).toMatchObject({ reason: "rate-limit", status: 429 });
  expect(error.message).toMatch(/^The provider rate limited this account until \w{3} \d+\D+\d+:\d\d [AP]M\. Switch accounts/);
  expect(calls).toBe(1);
});
test("a cooldown published by another agent process is shared without sharing profiles", async () => {
  const script = `import { coordinatedTransport } from ${JSON.stringify(import.meta.dir + "/rate-limit.ts")}; await coordinatedTransport('cross-process', async () => new Response(null, {status:429,headers:{'retry-after':'0.5'}}))('https://example.test');`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, ORCA_HOME: root }, stdout: "ignore", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  let called = false;
  const waiting = coordinatedTransport("cross-process", async () => { called = true; return new Response("ok"); })("https://example.test");
  expect((await coordinatedTransport("other-profile", async () => new Response("ok"))("https://example.test")).ok).toBe(true);
  expect(called).toBe(false);
  expect((await waiting).ok).toBe(true);
});
