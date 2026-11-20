// A Terminal for tests drawn by OpenTUI's test renderer through the same Display production uses: `screen()` is
// the rendered character frame, `spans()` its styled spans, and clicks go through OpenTUI's mouse like a real one.
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Display, type ScrollBy } from "../tui/otui";
import { parseKeys, type Key } from "../tui/components/keys";
import type { screens, Terminal } from "../tui/components";

export type TestTerminal = Terminal & {
  type(s: string): void;
  press(k: Key): void;
  /** The rendered frame's rows, trailing spaces trimmed. */
  lines(): string[];
  /** The rendered frame as one string, trailing blank rows dropped. */
  screen(): string;
  /** Wait until the latest shown screen has been rendered. */
  settled(): Promise<void>;
  /** The text of every bold span on `row`. */
  bold(row: number): string;
  /** A press and release on the cell (1-based x, y), through OpenTUI's mouse. */
  click(x: number, y: number): Promise<void>;
  resize(cols: number, rows: number): void;
  /** What was written raw (the transcript printed on exit), and each rendered frame's text, in order. */
  writes: string[];
  shown: screens.Screen | null;
  opened: boolean;
  closed: boolean;
};

export function testTerminal(cols = 40, rows = 24): TestTerminal {
  const keys: ((k: Key) => void)[] = [], resizers: (() => void)[] = [], actors: ((a: screens.ScreenAction) => void)[] = [];
  let setup: TestRendererSetup | null = null, display: Display | null = null, rendering: Promise<void> = Promise.resolve();
  // The frame is read right after each render (reading it while OpenTUI renders is refused), and kept until the next.
  let frame: string[] = [], spans: ReturnType<TestRendererSetup["captureSpans"]> | null = null;
  const render = () => {
    rendering = rendering.then(async () => {
      if (!setup) return;
      await setup.renderOnce();
      frame = setup.captureCharFrame().replace(/\n$/, "").split("\n").map(r => r.trimEnd());
      term.writes.push(frame.join("\n"));
      spans = setup.captureSpans();
    }).catch(() => undefined);
  };
  const term: TestTerminal = {
    cols, rows, writes: [], shown: null, opened: false, closed: false,
    write(s) { term.writes.push(s); },
    eraseOnExit() {},
    onKey(cb) { keys.push(cb); },
    onResize(cb) { resizers.push(cb); },
    onAction(cb) { actors.push(cb); },
    open() { term.opened = true; },
    close() { term.closed = true; void setup?.dispose().catch(() => undefined); },
    show(screen) { term.shown = screen; display?.show(screen); render(); },
    scroll(by: ScrollBy) { display?.scroll(by); render(); },
    selection() { return display?.selection() ?? ""; },
    press(k) { for (const h of keys) h(k); },
    type(s) { for (const k of parseKeys(s)) for (const h of keys) h(k); },
    lines() { return [...frame]; },
    screen() {
      const all = term.lines();
      while (all.length > 1 && all.at(-1) === "") all.pop();
      return all.join("\n");
    },
    settled: () => rendering,
    bold(row) {
      const line = spans?.lines[row];
      return (line?.spans ?? []).filter(span => (span.attributes & 1) !== 0).map(span => span.text).join("").trim();
    },
    async click(x, y) { await rendering; await setup?.mockMouse.click(x - 1, y - 1); },
    resize(c, r) { term.cols = c; term.rows = r; setup?.resize(c, r); for (const cb of resizers) cb(); render(); },
  };
  term.background = createTestRenderer({ width: cols, height: rows }).then(s => {
    setup = s;
    display = new Display(s.renderer, a => { for (const h of actors) h(a); }, k => { for (const h of keys) h(k); });
    if (term.shown) display.show(term.shown);
    render();
  });
  return term;
}
