import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
export function fixture(name: string) {
  return Array.from({ length: 36 }, (_, i): MessageParam[] => {
    const events = i === 0 ? `User prefers concise status. Project ${name} uses region eu-west-1. Retention is 14 days. Source https://example.org/${name}/policy. Proposal: publish dashboard; not authorized. Pending question: who owns escalation? Task audit-export blocked on legal approval; never restart automatically.`
      : i === 9 ? 'Correction: retention is now 30 days, replacing 14 days. Task schema-cleanup merged and completed; remove its implementation details.'
      : i === 20 ? 'Decision amended: region eu-north-1 replaces eu-west-1. Task audit-export remains blocked on legal approval. Dashboard publication still not authorized.'
      : i === 29 ? 'Escalation owner is Mira. New unresolved question: what is the rollback window? User still prefers concise status.' : 'Routine evidence review; no durable decision changes.';
    const rows = Array.from({ length: 215 }, (_, j) => `Batch ${i} case ${j}: component ${name}-${j % 17} returned status ${j % 11 ? 'pass' : 'review'}; observed latency ${40 + j % 37}ms. Synthetic test evidence only; temporary diagnostics, not standing instructions.`).join('\n');
    return [{ role: 'user', content: `Turn ${i + 1}. ${events}\n${rows}` }, { role: 'assistant', content: 'Evidence received. No deployment, restart, or publication performed.' }];
  });
}
export function score(text: string, turn: number) {
  const facts = ['concise', turn >= 21 ? 'eu-north-1' : 'eu-west-1', turn >= 10 ? '30 days' : '14 days', 'legal approval', 'not authorized', turn >= 30 ? 'rollback window' : 'escalation', 'https://example.org/'];
  const lower = text.toLowerCase();
  return { hits: facts.filter(f => lower.includes(f)), missing: facts.filter(f => !lower.includes(f)), total: facts.length,
    obsoleteMentions: [ ...(turn >= 10 ? ['14 days'] : []), ...(turn >= 21 ? ['eu-west-1'] : []) ].filter(f => lower.includes(f)),
    completedDetailMention: lower.includes('schema-cleanup'), unsafeImperatives: ['publish dashboard now', 'restart audit-export now'].filter(f => lower.includes(f)) };
}
export function registry() {
  return [{ id: 'audit-export', name: 'Audit export', summary: 'Blocked on legal approval; never restart automatically', branch: 'work/audit-export', status: 'working' as const, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', revision: 1, runs: [], history: [], attention: { kind: 'blocked' as const, reason: 'legal approval' } }];
}
