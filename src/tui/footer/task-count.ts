import type { TaskRow } from "../../protocol/task";

/** The status bar's `N tasks` group: the project's registered tasks not yet
 * archived as merged, cached per page and re-read only when asked (page open,
 * page switch, the poll's task-inbox refresh), never per frame. Reads are
 * single-flight: a refresh asked for during a read joins it, the next poll
 * reads again. Unknown (not yet read, or the last read failed) is `? tasks`,
 * never a fabricated 0. */
export class TaskCounts<P extends object> {
  private readonly counts = new WeakMap<P, { n?: number; pending?: Promise<void> }>();
  constructor(private readonly read: (page: P) => Promise<TaskRow[]>, private readonly current: (page: P) => boolean, private readonly changed: () => void) {}

  refresh(page: P): Promise<void> {
    const count = this.entry(page);
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

  private entry(page: P): { n?: number; pending?: Promise<void> } {
    const found = this.counts.get(page);
    if (found) return found;
    const count = {};
    this.counts.set(page, count);
    return count;
  }

  /** Only a page still open takes a result; a redraw only when the label moves. */
  private set(page: P, n: number | undefined): void {
    if (!this.current(page)) return;
    const before = this.label(page);
    this.entry(page).n = n;
    if (this.label(page) !== before) this.changed();
  }
}
