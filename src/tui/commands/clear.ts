interface ClearPage {
  deleting?: boolean; view: { name: string } | null; busy: boolean;
  sent: readonly unknown[]; questions: { closing: unknown };
  orch: { checkClear?: unknown; clear?: unknown };
}
/** Context resets keep their existing ownership, pending-input and idle guards. */
export function checkContextClear(page: ClearPage, current: ClearPage | undefined, pages: readonly ClearPage[], queued?: readonly unknown[]): void {
  if (!pages.includes(page) || page !== current || page.deleting) throw new Error("project changed; try again");
  if (page.view) throw new Error(`viewing ${page.view.name}; /back first to clear the orchestrator`);
  if (page.busy) throw new Error("orchestrator is running or compacting; wait before clearing context");
  if (page.sent.length || queued?.length || page.questions.closing) throw new Error("input is pending; context was not cleared");
  if (!page.orch.checkClear || !page.orch.clear) throw new Error("this session does not support clearing context");
}
