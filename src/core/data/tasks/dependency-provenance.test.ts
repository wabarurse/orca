import { expect, test } from 'bun:test';
import { validateProvenance, type ProvenanceTask } from './dependency-provenance';
function fixture(): ProvenanceTask {
  const head = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001';
  const task = { id, revision: 5, runs: [{id:'worker',role:'worker'}, {id:'review',role:'reviewer',reviewMode:'review'}] } as ProvenanceTask;
  const stack = { taskId:id, revision:1, baseCommit:head, defaultCommit:head,
    prerequisites:[{taskId:'parent', revision:1, commit:head}] };
  task.dependencyProvenance = { version:1, checkpoint:{taskId:id,revision:1,commit:head,clean:true,quiescent:true}, checkpointRun:'worker',
    checks:{head,defaultCommit:head,run:'worker',commands:['affected check'],validation:'passed'},
    review:{head,run:'review',validation:'reviewed'}, stack,
    replay:{stack,oldHead:head,newHead:head,onto:head,isolatedReplay:true,protectedRef:'refs/orca/dependency-replays/00000000-0000-4000-8000-000000000001',createdAt:'2026-01-01'} };
  return task;
}
test('named provenance validators preserve cross-field identity and ownership checks', () => {
  expect(() => validateProvenance(fixture())).not.toThrow();
  const mutations: ((t: ProvenanceTask) => void)[] = [
    t => { t.dependencyProvenance!.checkpoint!.taskId = 'other'; },
    t => { t.dependencyProvenance!.checkpoint!.revision = 6; },
    t => { t.dependencyProvenance!.checkpointRun = 'review'; },
    t => { t.dependencyProvenance!.checks!.run = 'review'; },
    t => { t.dependencyProvenance!.checks!.commands = ['']; },
    t => { t.dependencyProvenance!.review!.run = 'worker'; },
    t => { t.dependencyProvenance!.stack!.taskId = 'other'; },
    t => { t.dependencyProvenance!.stack!.prerequisites.push(t.dependencyProvenance!.stack!.prerequisites[0]!); },
    t => { t.dependencyProvenance!.replay!.stack = { ...t.dependencyProvenance!.stack!, baseCommit:'b'.repeat(40) }; },
    t => { t.dependencyProvenance!.replay!.protectedRef = 'refs/heads/main'; },
  ];
  for (const mutate of mutations) { const t = fixture(); mutate(t); expect(() => validateProvenance(t)).toThrow(); }
});
