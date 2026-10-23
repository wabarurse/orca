import { test, expect } from 'bun:test';
import { fixture, score, registry } from './fixtures';
import { estimate } from '../../src/compaction';
import { rollingCut } from '../../src/rolling-memory';
import { parseMemory } from '../../src/rolling-summary';
test('fixtures deterministic, long, and preserve whole tail', () => {
 for (const name of ['migration','incident']) {
  const messages = fixture(name).flat();
  expect(messages).toEqual(fixture(name).flat());
  expect(estimate(messages)).toBeGreaterThan(100000);
  const cut = rollingCut(messages, 20000);
  expect(estimate(messages.slice(cut))).toBeLessThan(20000);
  expect(messages.slice(cut).length).toBeGreaterThan(0);
 }
});
test('rubric distinguishes corrections and lexical flags', () => {
 const s = score('30 days, not 14 days; eu-north-1. publish dashboard now', 36);
 expect(s.hits).toContain('30 days'); expect(s.obsoleteMentions).toContain('14 days'); expect(s.unsafeImperatives).toHaveLength(1);
});
test('named blocked task has authoritative registry', () => {
 expect(parseMemory(JSON.stringify({user:[],project:[],pending:[],tasks:[{id:'audit-export',notes:'blocked'}]}),registry()).tasks).toHaveLength(1);
});
