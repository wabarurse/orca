import { dim, fit, visibleLength, wordWrap, plainText } from "./text";

export function workColumns(cols: number) {
  const split = cols >= 48;
  const left = split ? Math.floor((cols - 3) * 0.42) : cols;
  return { split, left, right: split ? cols - left - 3 : cols };
}

/** Shared list/details layout. Narrow terminals stack the panes. */
export function workRows(title: string, cols: number, left: string[], right: string[]): string[] {
  const widths = workColumns(cols);
  if (!widths.split) return [fit(title, cols), ...left, dim("─".repeat(cols)), ...right];
  return [fit(title, cols), ...Array.from({ length: Math.max(left.length, right.length) }, (_, i) => {
    const list = fit(left[i] ?? "", widths.left);
    return list + " ".repeat(Math.max(0, widths.left - visibleLength(list))) + dim(" │ ") + fit(right[i] ?? "", widths.right);
  })];
}

export function workDetails(text: string, cols: number): string[] {
  return plainText(text).split("\n").flatMap(line => wordWrap(line, cols));
}
