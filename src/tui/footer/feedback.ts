import { dim, fit, sanitize } from "../components";

export interface Feedback {
  content: string | readonly string[];
  lifetime: "ephemeral" | "persistent";
  loading?: boolean;
}
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** Reusable, owner-scoped content above the composer. Persistent operations and
 * dismissible notices can coexist; rendering never consumes either one. */
export class InputFeedback<Owner extends object> {
  private owners = new WeakMap<object, Map<string, Feedback>>();
  private loose = {};
  set(owner: Owner | undefined, id: string, value: Feedback): void {
    const key = owner ?? this.loose, items = this.owners.get(key) ?? new Map<string, Feedback>();
    items.set(id, value); this.owners.set(key, items);
  }
  remove(owner: Owner | undefined, id: string): boolean { return this.owners.get(owner ?? this.loose)?.delete(id) ?? false; }
  clear(owner: Owner | undefined): boolean { return this.owners.delete(owner ?? this.loose); }
  move(from: Owner | undefined, to: Owner): void {
    const items = this.owners.get(from ?? this.loose);
    for (const [id, item] of items ?? []) this.set(to, id, item);
    this.clear(from);
  }
  dismiss(owner: Owner | undefined): void {
    const items = this.owners.get(owner ?? this.loose);
    for (const [id, item] of items ?? []) if (item.lifetime === "ephemeral") items!.delete(id);
  }
  rows(owner: Owner | undefined, cols: number, now: number, maxRows = 3): string[] {
    if (maxRows <= 0) return [];
    const items = [...this.owners.get(owner ?? this.loose)?.values() ?? []];
    // Persistent operations remain nearest the input, even when another notice arrives.
    items.sort((a, b) => Number(a.lifetime === "persistent") - Number(b.lifetime === "persistent"));
    return items.flatMap(item => (typeof item.content === "string" ? [item.content] : item.content).flatMap(line => line.split("\n")).slice(0, maxRows)
      .map((line, i) => dim(fit(sanitize(`${item.loading && i === 0 ? SPINNER[Math.floor(now / 120) % SPINNER.length] + " " : ""}${line}`), cols))))
      .slice(-Math.max(0, maxRows));
  }
}

/** Keep the detailed runtime log out of the small, one-time completion notice. */
export function compactedNotice(text: string): string {
  const match = /^compaction complete: ~(\d+) → ~(\d+) history tokens/.exec(text);
  return match ? `Compacted ${Math.round(Number(match[1]) / 1000)}k → ${Math.round(Number(match[2]) / 1000)}k` : text;
}
