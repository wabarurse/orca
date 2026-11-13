import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { paths, updateState } from "../config";
import { anthropic } from "./anthropic";
import { diagnoseModelError } from "./model-diagnostics";
import { AccountCooldownError, coordinatedTransport, RECHECK_MS } from "./rate-limit";
import { transientFailure, withTransientRetries } from "./retry";
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
test("long Retry-After fails closed rather than consuming requests or holding a model stream", async () => {
  await coordinatedTransport("long", async () => new Response(null, { status: 429, headers: { "retry-after": "3600" } }))("https://example.test");
  await expect(coordinatedTransport("long", async () => { throw Error("HTTP must not run"); })("https://example.test")).rejects.toMatchObject({ status: 429 });
  let retries = 0;
  await expect(withTransientRetries(() => coordinatedTransport("long", async () => { throw Error("HTTP must not run"); })("https://example.test"), { backoffMs: [0, 0], onRetry: () => { retries++; } })).rejects.toMatchObject({ status: 429 });
  expect(retries).toBe(0);
});
test("a cooldown published by another agent process is shared without sharing profiles", async () => {
  const script = `import { coordinatedTransport } from ${JSON.stringify(import.meta.dir + "/rate-limit.ts")}; await coordinatedTransport('cross-process', async () => new Response(null, {status:429,headers:{'retry-after':'3600'}}))('https://example.test');`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, ORCA_HOME: root }, stdout: "ignore", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  await expect(coordinatedTransport("cross-process", async () => { throw Error("must not call HTTP"); })("https://example.test")).rejects.toMatchObject({ status: 429 });
  expect((await coordinatedTransport("other-profile", async () => new Response("ok"))("https://example.test")).ok).toBe(true);
});
test("a long lockout is asked about again after the recheck interval, once, and a success ends it", async () => {
  const limited = async () => new Response(null, { status: 429, headers: { "retry-after": "3600" } });
  await coordinatedTransport("recheck", limited)("https://example.test");
  const age = (ms: number) => updateState<{ checkedAt?: number }>(paths.memory, "provider-rate:recheck", "cooldown", old => ({ ...old!, checkedAt: Date.now() - ms }));
  let calls = 0;
  const count = async () => { calls++; return limited(); };
  age(RECHECK_MS - 5000);
  await expect(coordinatedTransport("recheck", count)("https://example.test")).rejects.toBeInstanceOf(AccountCooldownError);
  age(RECHECK_MS);
  expect((await coordinatedTransport("recheck", count)("https://example.test")).status).toBe(429);
  await expect(coordinatedTransport("recheck", count)("https://example.test")).rejects.toBeInstanceOf(AccountCooldownError);
  expect(calls).toBe(1);
  age(RECHECK_MS);
  expect((await coordinatedTransport("recheck", async () => new Response("ok"))("https://example.test")).ok).toBe(true);
  expect((await coordinatedTransport("recheck", async () => new Response("ok"))("https://example.test")).ok).toBe(true);
});
test("a lockout the SDK wrapped is reported as a rate limit with its time, never as a connection failure", async () => {
  const until = Date.now() + 3600_000;
  for (const wrapped of [new Error("Connection error.", { cause: new AccountCooldownError(until) }), new AccountCooldownError(until)]) {
    expect(transientFailure(wrapped)).toBeUndefined();
    expect(diagnoseModelError(wrapped, false, "connection")).toMatchObject({ reason: "rate-limit", status: 429 });
  }
  const transport = Object.assign(async () => Response.json({ type: "error", error: { type: "rate_limit_error", message: "x" } }, { status: 429, headers: { "retry-after": "3600" } }), { preconnect: fetch.preconnect });
  const provider = anthropic(new Anthropic({ apiKey: "test", fetch: transport }), { recovery: { enabled: true, account: "wrapped", idleMs: 100, totalMs: 2000 }, retry: { backoffMs: [0, 0] } });
  const request = { model: "test", messages: [{ role: "user" as const, content: "hi" }], tools: [], maxTokens: 100, onText() {} };
  for (let i = 0; i < 2; i++) {
    const error = await provider.complete(request).catch(error => error);
    expect(error).toMatchObject({ reason: "rate-limit", status: 429 });
    expect(error.message).toMatch(/^The provider rate limited this account until \w{3} \d+\D+\d+:\d\d [AP]M\. Switch accounts/);
  }
});
