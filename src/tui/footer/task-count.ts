import type { TaskRow } from "../../protocol/task";

/** The status bar's `N tasks` group: the project's registered tasks not yet
 * archived as merged, cached per page and re-read only when asked (page open,
 * page switch, the poll's task-inbox refresh), never per frame. Reads are
 * single-flight: a refresh asked for during a read joins it, the next poll
 * reads again. Unknown (not yet read, or the last read failed) is `? tasks`,
 * never a fabricated 0. The same refresh reads the `N processes` group
 * (what runs in the background: PR watches, commands, agent-opened tmux
 * sessions) through `running`, with the same rules. */
export class TaskCounts<P extends object> {
  private readonly counts = new WeakMap<P, { n?: number; running?: number; pending?: Promise<void>; counting?: Promise<void> }>();
  constructor(private readonly read: (page: P) => Promise<TaskRow[]>, private readonly current: (page: P) => boolean, private readonly changed: () => void,
    private readonly running: (page: P) => Promise<number>) {}

  refresh(page: P): Promise<void> {
    const count = this.entry(page);
    // The two reads are single-flight apart: the process read asks tmux and must never hold a task count back.
    count.counting ??= Promise.resolve(page).then(this.running).then(n => this.set(page, n, "running"), () => this.set(page, undefined, "running"))
      .finally(() => { count.counting = undefined; });
    return count.pending ??= this.observe(page, Promise.resolve(page).then(this.read)).then(() => {}, () => {})
      .finally(() => { count.pending = undefined; });
  }

  /** Any read of the page's task rows (the Tasks panel's too) sets the count; the read's result passes through unchanged. */
  observe(page: P, read: Promise<TaskRow[]>): Promise<TaskRow[]> {
    return read.then(rows => { this.set(page, rows.filter(row => !row.archive).length); return rows; },
      error => { this.set(page, undefined); throw error; });
  }

  label(page: P): string {
    const n = this.counts.get(page)?.n;
    return `${n ?? "?"} ${n === 1 ? "task" : "tasks"}`;
  }

  processes(page: P): string {
    const n = this.counts.get(page)?.running;
    return `${n ?? "?"} ${n === 1 ? "process" : "processes"}`;
  }

  /** The status line with the processes group last, when one row of `cols` holds it: the group never costs a
   * narrow terminal a second status row. */
  withProcesses(page: P, status: string, cols: number): string {
    const full = `${status} | ${this.processes(page)}`;
    return full.length <= cols ? full : status;
  }

  private entry(page: P): { n?: number; running?: number; pending?: Promise<void>; counting?: Promise<void> } {
    const found = this.counts.get(page);
    if (found) return found;
    const count = {};
    this.counts.set(page, count);
    return count;
  }

  /** Only a page still open takes a result; a redraw only when the label moves. */
  private set(page: P, n: number | undefined, field: "n" | "running" = "n"): void {
    if (!this.current(page)) return;
    const before = this.label(page) + this.processes(page);
    this.entry(page)[field] = n;
    if (this.label(page) + this.processes(page) !== before) this.changed();
  }
}
