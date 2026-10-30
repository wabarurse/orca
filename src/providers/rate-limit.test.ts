import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coordinatedTransport } from "./rate-limit";
import { withTransientRetries } from "./retry";
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
