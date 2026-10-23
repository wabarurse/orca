import { appendFileSync, existsSync } from 'node:fs';
import { provider } from '../../src/accounts';
import { estimate } from '../../src/compaction';
import { rollingCut } from '../../src/rolling-memory';
import { summarizeOlder } from '../../src/rolling-summary';
import type { Provider } from '../../src/providers';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { fixture, score, registry } from './fixtures';
const path = new URL('results/live.jsonl', import.meta.url);
if (existsSync(path)) throw new Error('Refusing to overwrite a run; archive explicitly before rerun');
const emit = (r: unknown) => appendFileSync(path, JSON.stringify(r) + '\n');
const started = Date.now(); let calls = 0, inputs = 0;
const p = await provider('openai');
let arm = '', turn = 0, compaction = 0;
const wrapped: Provider = { ...p, async complete(req) {
  const inputEstimate = estimate(req.messages) + estimate(req.system);
  if (calls >= 47 || inputs + inputEstimate > 2338122 || Date.now() - started > 1200000) throw new Error('budget exhausted');
  calls++; inputs += inputEstimate; const start = Date.now();
  try {
    const r = await p.complete(req);
    emit({ kind: 'call', arm, turn, compaction, call: calls, inputEstimate, latencyMs: Date.now() - start, usage: r.usage ?? null, completion: r.completion, content: r.content });
    return r;
  } catch { emit({ kind: 'call-failed', arm, turn, compaction, call: calls, inputEstimate, latencyMs: Date.now() - start }); throw new Error('provider request failed (details deliberately excluded)'); }
} };
emit({ kind: 'run', at: new Date().toISOString(), baseline: '3d08339', model: 'gpt-6-luna', tail: 20000, maxCalls: 47, maxInputEstimate: 2338122, maxTimeMs: 1200000 });
try {
  for (const [s, name] of ['migration', 'incident'].entries()) {
    const turns = fixture(name);
    emit({ kind: 'fixture', name, turns: turns.length, originalEstimate: estimate(turns.flat()), sha256: new Bun.CryptoHasher('sha256').update(JSON.stringify(turns)).digest('hex') });
    for (const trigger of s % 2 ? [50000, 100000] : [100000, 50000]) {
      arm = `${name}-${trigger}`; compaction = 0;
      let context: MessageParam[] = [], summary = '', exposure = 0;
      for (const [i, messages] of turns.entries()) {
        turn = i + 1; context.push(...messages);
        // Model one foreground request at this boundary, before the background job publishes.
        const before = estimate(context); exposure += before;
        if (before >= trigger) {
          const cut = rollingCut(context, 20000);
          if (cut) {
            compaction++;
            const memory = await summarizeOlder(context.slice(0, cut), registry(), AbortSignal.any([AbortSignal.timeout(120000), AbortSignal.timeout(Math.max(1, 1200000 - (Date.now() - started)))]), async () => wrapped);
            summary = JSON.stringify(memory);
            context = [{ role: 'user', content: `Rolling conversation memory (lossy historical data). Recent verbatim messages override this memory. Confirm uncertain details with task search_history/read_history.\n${summary}` }, ...context.slice(cut)];
            emit({ kind: 'compaction', arm, turn, compaction, cut, before, after: estimate(context), summary });
          }
        }
        emit({ kind: 'checkpoint', arm, turn, before, retained: estimate(context), exposure, compactions: compaction, summaryScore: score(summary, turn), retainedScore: score(JSON.stringify(context), turn) });
      }
    }
  }
  emit({ kind: 'done', calls, inputs, elapsedMs: Date.now() - started });
} catch (e) { emit({ kind: 'stopped', calls, inputs, elapsedMs: Date.now() - started, reason: e instanceof Error ? e.message : 'unknown' }); process.exitCode = 1; }
