// The chat screen as data (components/screen-view.ts): the shown history (conversation/lines.ts `Shown`) as screen items,
// plus the header, the live tail and the footer rows. Pure; App builds it per frame and the terminal draws it.
import { lineRows, foldTitle, messageRows, tally, toolRows, type Shown } from "../conversation";
import { dim, fit, sanitize, screens, userFill, wrap } from "../components";
import { liveRows, type Frame } from "../footer";
import { headerHeight, whaleRows } from "../header";

/** Columns the conversation is laid out in: the whole width. */
export const bodyCols = (cols: number) => Math.max(1, cols);

const OPENS: Record<string, screens.OpenTab> = { questions: "questions", images: "images", agents: "agents", tasks: "tasks" };
const userText = (line: string) => Bun.stripANSI(line).replace(/^> ?|^ {2}/, "");
const isFold = (l: Shown): l is Extract<Shown, { key: string }> => typeof l !== "string" && "key" in l;
/** Folds that stack with the one before them (a turn's "+ N …" groups; agent messages in a row), with no blank between. */
const stacks = (l: Shown, previous: Shown | undefined) =>
  previous !== undefined && isFold(l) && isFold(previous) && ("group" in l || "from" in l) && ("group" in previous || "from" in previous || "calls" in previous);

/** One shown line's screen item; `gap` puts a blank row above it, as historyRows did between blocks. */
function item(l: Shown, key: string, gap: boolean, cols: number): screens.ScreenItem {
  if (!isFold(l)) return { kind: "rows", key, gap, rows: lineRows(l, cols) };
  const title = foldTitle(l);
  if ("calls" in l) {
    const failed = l.calls.filter(c => c.failed).length;
    return { kind: "fold", key: l.key, gap, title: sanitize(`${title} · ${tally(l.calls)}`), failed: failed ? ` · ${failed} failed` : "", open: l.open, rows: l.open ? l.calls.flatMap(c => toolRows(c, Math.max(1, cols - 2))) : [], opens: null };
  }
  if ("group" in l) return { kind: "fold", key: l.key, gap, title, failed: "", open: l.open, rows: l.items.map(text => fit(`${dim("●")} ${sanitize(text)}  \x1b[38;5;153mopen\x1b[0m`, Math.max(1, cols - 2))), opens: OPENS[l.group] ?? null };
  return { kind: "fold", key: l.key, gap, title, failed: "", open: l.open, rows: messageRows(l.text, Math.max(1, cols - 7)).map((row, i) => `${dim(i ? " " : "⎿")}  ${row}`), opens: null };
}

/** A real boundary between blocks (not a wrapped row or a streaming paragraph's next chunk): what earns a blank above. */
function startsBlock(l: Shown): boolean {
  if (typeof l === "string") return false;
  if ("user" in l) return false;
  if ("md" in l) return !l.continuation && !!l.md.trim();
  return true;
}

/** The shown history as screen items: a user message's lines become one block; everything else one item per line. */
export function chatItems(shown: readonly Shown[], cols: number): screens.ScreenItem[] {
  const width = bodyCols(cols), out: screens.ScreenItem[] = [];
  let user: string[] | null = null, start = 0, previous: Shown | undefined;
  const flush = () => { if (user) out.push({ kind: "user", key: `user:${start}`, gap: false, rows: user, fill: userFill() }); user = null; };
  shown.forEach((l, i) => {
    if (typeof l !== "string" && "user" in l) {
      if (!user || Bun.stripANSI(l.user).startsWith(">")) { flush(); user = []; start = i; }
      user.push(userText(l.user));
      previous = l; return;
    }
    flush();
    const gap = out.length > 0 && startsBlock(l) && !stacks(l, previous) && previous !== undefined && !(typeof previous !== "string" && "user" in previous);
    out.push(item(l, `${i}`, gap, width));
    previous = l;
  });
  flush();
  return out;
}

/** The header's rows on screen at `cols`: the tabs, the account and the details (or the fin beside them, when taller), and the box's bottom line. */
export const headerRows = (header: screens.ScreenHeader | null, cols: number) => {
  if (!header) return 0;
  const text = 1 + (header.bubble === null ? 0 : 1) + (header.account === null ? 0 : 1) + header.details.length;
  return 1 + Math.max(text, header.fin !== null && cols >= screens.FIN_MIN_COLS ? screens.FIN_ROWS : 0);
};

/** The header the screen has room for: none when it would take more than a third of the rows (tiny terminals keep the input and counts first). */
export const fittingHeader = (header: screens.ScreenHeader | null, cols: number, rows: number) => header && headerRows(header, cols) <= headerHeight(rows) ? header : null;

/** The whole chat screen from the frame's parts: the footer is the composer region liveRows lays out, the tail its live rows. */
export function chatScreen(f: Frame, items: screens.ScreenItem[], header: screens.ScreenHeader | null): screens.ChatScreen {
  const height = Math.max(1, f.rows), top = headerRows(header, f.cols);
  const footer = liveRows({ ...f, rows: Math.max(1, height - top - 1), partial: "", running: [], activity: undefined });
  const width = bodyCols(f.cols);
  const partial = f.partial ? f.partial.split("\n").flatMap(line => wrap(sanitize(line), width)) : [];
  const tail = [...partial, ...(f.running ?? []), ...(f.activity ? [f.activity] : [])];
  const body = Math.max(0, height - top - footer.rows.length);
  return {
    kind: "chat", header, items, tail,
    welcome: f.welcome && !items.length && !tail.length ? whaleRows(f.cols, body) : [],
    footer: footer.rows, cursor: { row: footer.cursor, col: footer.col },
  };
}
