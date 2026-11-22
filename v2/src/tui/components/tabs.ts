import { visibleLength } from "./text";

const tabSpan = (labels: string[], start: number, end: number): string => `${start > 0 ? "…   " : ""}${labels.slice(start, end + 1).join("   ")}${end < labels.length - 1 ? "   …" : ""}`;

export function tabWindow(labels: string[], active: number, cols: number): [number, number] {
  let start = active, end = active;
  for (;;) {
    if (start > 0 && visibleLength(tabSpan(labels, start - 1, end)) <= cols) start--;
    else if (end < labels.length - 1 && visibleLength(tabSpan(labels, start, end + 1)) <= cols) end++;
    else return [start, end];
  }
}
