import { provider } from "../../src/accounts";
const start = Date.now();
const record: Record<string, unknown> = { kind: "capability", model: "gpt-6-luna", at: new Date().toISOString(), budget: { calls: 1, timeoutMs: 30000, maxTokens: 32 } };
try {
  const p = await provider("openai");
  const r = await p.complete({ model: "gpt-6-luna", settings: { effort: "low", fast: false }, messages: [{ role: "user", content: "Reply only OK. Synthetic compaction evaluation capability check." }], tools: [], maxTokens: 32, onText() {}, signal: AbortSignal.timeout(30000) });
  Object.assign(record, { ok: true, usage: r.usage ?? null, completion: r.completion, content: r.content });
} catch (e) {
  // Do not persist arbitrary provider bodies, account IDs, headers or local paths.
  const message = e instanceof Error ? e.message : String(e);
  Object.assign(record, { ok: false, status: (e as { status?: number }).status ?? null,
    reason: /not supported/.test(message) ? "requested model not supported" : /not signed in/.test(message) ? "existing account not signed in" : /timeout|timed out/i.test(message) ? "deadline exceeded" : "provider request failed",
    modelMentioned: message.includes("gpt-6-luna") });
}
record.latencyMs = Date.now() - start;
await Bun.write(new URL("results/probe.json", import.meta.url), JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record));
