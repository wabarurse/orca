import { BoxRenderable, RGBA, ScrollBoxRenderable, StyledText, TextAttributes, TextRenderable, type MouseEvent, type RenderContext, type TextChunk } from "@opentui/core";
import { CollapsiblePanelRenderable, CollapsibleRootRenderable, CollapsibleTriggerRenderable } from "@tuiparts/core/collapsible";
import { linkAt, linkSpanAt, screens, underlineSpan, type LinkSpan } from "../components";
import { tabWindow } from "../components";
import { applySgr, styledRows } from "./ansi";

export const COLOURS = {
  light: "#afd7ff",
  mid: "#87afd7",
  dark: "#5f87af",
  text: "#d0d0d0",
  muted: "#949494",
  faint: "#808080",
  surface: "#303030",
  red: "#ffafaf",
  ink: "#1c1c1c",
  fin: "#eeeeee",
};

const { FIN_COLS, FIN_MIN_COLS } = screens;

const chunk = (text: string, fg: string, attributes = TextAttributes.NONE, bg: string | null = null): TextChunk => ({
  __isChunk: true,
  text,
  fg: RGBA.fromHex(fg),
  bg: bg === null ? undefined : RGBA.fromHex(bg),
  attributes,
});

const styled = (chunks: TextChunk[]): StyledText => new StyledText(chunks);

const SGR = /^\x1b\[([0-9;:]*)m$/;

export function fillColour(fill: string | null): RGBA | null {
  if (fill === null) return null;
  const match = SGR.exec(fill);
  const params = match === null ? undefined : match[1];
  if (params === undefined) return null;
  return applySgr({ fg: null, bg: null, attributes: TextAttributes.NONE, link: null }, params).bg;
}

export function finRows(cols: number, time: number, active: boolean): string[] {
  const tick = active ? Math.floor(time / 180) : 0;
  const grid = Array.from({ length: 5 }, () => Array.from({ length: cols }, () => " "));
  const travel = cols - 10;
  const phase = (tick * 0.55) % (travel * 2);
  const x = 2 + Math.floor(phase < travel ? phase : travel * 2 - phase);
  const set = (row: number, col: number, ch: string): void => {
    const line = grid[row];
    if (line !== undefined && col >= 0 && col < cols) line[col] = ch;
  };
  for (let col = 0; col < cols; col++) set(3, col, "~__~~_".charAt((col + Math.floor(tick / 2)) % 6));
  ["   #,", "   ###", "  #####"].forEach((shape, row) => {
    for (let col = 0; col < shape.length; col++) if (shape.charAt(col) !== " ") set(row, x + col, shape.charAt(col));
  });
  for (let col = x + 1; col < x + 7; col++) set(3, col, "#");
  for (let distance = 2; distance < 9; distance += 3) if (x >= distance) set(4, x - distance, ".");
  return grid.map(row => row.join(""));
}

export function finText(cols: number, time: number, active: boolean): StyledText {
  const chunks: TextChunk[] = [];
  finRows(cols, time, active).forEach((row, i) => {
    if (i > 0) chunks.push(chunk("\n", COLOURS.mid));
    for (const run of row.match(/#+,?|[^#]+/g) ?? []) chunks.push(chunk(run, run.startsWith("#") ? COLOURS.fin : COLOURS.mid));
  });
  return styled(chunks);
}

type Built = { item: screens.ScreenItem; node: BoxRenderable };

type Place = { following: boolean; top: number };

const sameRows = (a: string[], b: string[]): boolean => a === b || (a.length === b.length && a.every((row, i) => row === b[i]));

function sameItem(a: screens.ScreenItem, b: screens.ScreenItem): boolean {
  if (a.kind !== b.kind || a.key !== b.key || a.gap !== b.gap || !sameRows(a.rows, b.rows)) return false;
  if (a.kind === "user" && b.kind === "user") return a.fill === b.fill && a.open === b.open && a.more === b.more;
  if (a.kind !== "fold" || b.kind !== "fold") return true;
  return a.title === b.title && a.failed === b.failed && a.open === b.open && a.opens === b.opens;
}

export type ChatEvents = { action: (action: screens.ScreenAction) => void };

export class ChatView {
  readonly root: BoxRenderable;
  private readonly header: BoxRenderable;
  private readonly info: BoxRenderable;
  private readonly fin: TextRenderable;
  private readonly body: ScrollBoxRenderable;
  private readonly tail: TextRenderable;
  private readonly welcome: BoxRenderable;
  private readonly welcomeArt: TextRenderable;
  private readonly footer: TextRenderable;
  private footerHeight = 1;
  private built: { key: string; item: Built }[] = [];
  private headerSig = "";
  private pressed: { x: number; y: number } | null = null;
  private readonly hint: TextRenderable;
  private readonly places = new Map<string, Place>();
  private view: string | null = null;

  constructor(private readonly ctx: RenderContext, private readonly events: ChatEvents) {
    this.root = new BoxRenderable(ctx, { flexDirection: "column", width: "100%", height: "100%" });
    this.header = new BoxRenderable(ctx, { border: ["left", "right", "bottom"], borderStyle: "single", borderColor: COLOURS.light, paddingX: 1, flexDirection: "row", flexShrink: 0 });
    this.info = new BoxRenderable(ctx, { flexDirection: "column", flexGrow: 1, flexShrink: 1 });
    this.fin = new TextRenderable(ctx, { content: "", width: FIN_COLS, flexShrink: 0, wrapMode: "none" });
    this.header.add(this.info);
    this.header.add(this.fin);
    this.body = new ScrollBoxRenderable(ctx, {
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
      scrollY: true,
      scrollX: false,
      contentOptions: { flexDirection: "column" },
      verticalScrollbarOptions: { visible: false },
    });
    this.tail = new TextRenderable(ctx, { content: "", wrapMode: "none", selectable: true });
    this.welcome = new BoxRenderable(ctx, { flexGrow: 1, justifyContent: "center", alignItems: "center", visible: false });
    this.welcomeArt = new TextRenderable(ctx, { content: "", wrapMode: "none", fg: COLOURS.muted });
    this.welcome.add(this.welcomeArt);
    this.footer = new TextRenderable(ctx, { content: "", wrapMode: "none", flexShrink: 0, selectable: false });
    this.footer.onMouseDown = (event: MouseEvent) => { this.footerMouse("down", event); };
    this.footer.onMouseDrag = (event: MouseEvent) => { this.footerMouse("drag", event); };
    this.footer.onMouseUp = (event: MouseEvent) => { this.footerMouse("up", event); };
    this.footer.onMouseDragEnd = (event: MouseEvent) => { this.footerMouse("up", event); };
    this.hint = new TextRenderable(ctx, { content: "", wrapMode: "none", position: "absolute", right: 2, bottom: 1, zIndex: 10, visible: false, selectable: false });
    this.hint.onMouseDown = (event: MouseEvent) => { this.pressed = { x: event.x, y: event.y }; };
    this.hint.onMouseUp = (event: MouseEvent) => { this.click(event, () => { this.scroll("end"); }); };
    this.body.add(this.tail);
    this.body.content.on("resize", () => { this.showHint(); });
    this.body.viewport.on("resize", () => { this.showHint(); });
    this.body.verticalScrollBar.on("change", () => { this.showHint(); });
    this.root.add(this.header);
    this.root.add(this.body);
    this.root.add(this.welcome);
    this.root.add(this.footer);
    this.root.add(this.hint);
  }

  rowsBelow(): number {
    return Math.max(0, this.body.scrollHeight - this.body.viewport.height - this.body.scrollTop);
  }

  following(): boolean {
    return this.rowsBelow() === 0;
  }

  private showHint(): void {
    const below = this.body.visible ? this.rowsBelow() : 0;
    this.hint.visible = below > 0;
    if (below > 0) this.hint.content = styled([chunk(` ↓ ${below} more line${below === 1 ? "" : "s"} below · PgDn `, COLOURS.ink, TextAttributes.BOLD, COLOURS.light)]);
  }

  private switchView(view: string): Place | null {
    if (view === this.view) return null;
    if (this.view !== null) this.places.set(this.view, { following: this.following(), top: this.body.scrollTop });
    this.view = view;
    return this.places.get(view) ?? { following: true, top: 0 };
  }

  show(screen: screens.ChatScreen, cols: number): void {
    this.showHeader(screen.header, cols);
    const restore = this.switchView(screen.view);
    this.showItems(screen.items, screen.tail, restore === null);
    const empty = screen.items.length === 0 && screen.tail.length === 0 && screen.welcome.length > 0;
    this.welcome.visible = empty;
    this.body.visible = !empty;
    this.welcomeArt.content = styledRows(screen.welcome);
    this.footer.content = styledRows(screen.footer);
    this.footerHeight = Math.max(1, screen.footer.length);
    this.footer.height = this.footerHeight;
    this.body.marginBottom = this.ctx.height >= 8 ? 1 : 0;
    this.hint.bottom = this.footerHeight + this.body.marginBottom;
    if (restore !== null) this.body.scrollTo(restore.following ? Number.MAX_SAFE_INTEGER : restore.top);
    this.showHint();
  }

  private footerMouse(phase: "down" | "drag" | "up", event: MouseEvent): void {
    if (event.button !== 0) return;
    this.events.action({ kind: "input", phase, row: event.y - this.footer.y, col: event.x - this.footer.x });
  }

  footerRows(): number {
    return this.footerHeight;
  }

  scroll(by: "up" | "down" | "page-up" | "page-down" | "home" | "end"): void {
    const page = Math.max(1, this.body.height - 1);
    if (by === "home") this.body.scrollTo(0);
    else if (by === "end") this.body.scrollTo(Number.MAX_SAFE_INTEGER);
    else this.body.scrollBy(by === "up" ? -1 : by === "down" ? 1 : by === "page-up" ? -page : page);
    if (by !== "home" && by !== "end" && this.rowsBelow() <= 1) this.body.scrollTo(Number.MAX_SAFE_INTEGER);
    this.showHint();
  }

  private showHeader(header: screens.ScreenHeader | null, cols: number): void {
    this.header.visible = header !== null;
    if (header === null) return;
    const wide = cols >= FIN_MIN_COLS && header.fin !== null;
    this.fin.visible = wide;
    if (wide && header.fin !== null) this.fin.content = finText(FIN_COLS, header.fin.time, header.fin.active);
    const sig = JSON.stringify([header.tabs, header.bubble, header.account, header.details, wide, cols]);
    if (sig === this.headerSig) return;
    this.headerSig = sig;
    for (const child of this.info.getChildren()) child.destroyRecursively();
    const labels = header.tabs.map(tab => tab.active ? ` ${tab.label} ` : tab.busy ? `${tab.label} •` : tab.label);
    const active = Math.max(0, header.tabs.findIndex(tab => tab.active));
    const [start, end] = tabWindow(labels, active, Math.max(1, cols - 4 - (wide ? FIN_COLS : 0)));
    const tabs: TextChunk[] = start > 0 ? [chunk("…   ", COLOURS.faint)] : [];
    for (let i = start; i <= end; i++) {
      if (i > start) tabs.push(chunk("   ", COLOURS.faint));
      tabs.push(i === active ? chunk(labels[i] ?? "", COLOURS.ink, TextAttributes.BOLD, COLOURS.light) : chunk(labels[i] ?? "", COLOURS.faint));
    }
    if (end < labels.length - 1) tabs.push(chunk("   …", COLOURS.faint));
    this.info.add(new TextRenderable(this.ctx, { content: styled(tabs), wrapMode: "none" }));
    if (header.bubble !== null) this.info.add(new TextRenderable(this.ctx, { content: styled([chunk(header.bubble, COLOURS.mid)]), wrapMode: "none" }));
    if (header.account !== null) this.info.add(new TextRenderable(this.ctx, { content: styled([chunk(header.account, COLOURS.mid)]), wrapMode: "none" }));
    for (const row of header.details) {
      const at = row.indexOf(" · ");
      const head = at === -1 ? row : row.slice(0, at);
      const rest = at === -1 ? "" : row.slice(at);
      this.info.add(new TextRenderable(this.ctx, { content: styled([chunk(head, COLOURS.light), chunk(rest, COLOURS.faint)]), wrapMode: "none" }));
    }
  }

  private showItems(items: screens.ScreenItem[], tail: string[], hold: boolean): void {
    const next: { key: string; item: Built }[] = [];
    const previous = new Map(this.built.map(entry => [entry.key, entry.item]));
    const kept = new Set<BoxRenderable>();
    for (const item of items) {
      const old = previous.get(item.key);
      if (old !== undefined && sameItem(old.item, item)) { next.push({ key: item.key, item: old }); previous.delete(item.key); kept.add(old.node); continue; }
      next.push({ key: item.key, item: { item, node: this.build(item) } });
    }
    const same = next.length === this.built.length && next.every((entry, i) => this.built[i]?.item === entry.item);
    const anchor = same || !hold || this.following() ? null : this.readingNode(kept);
    for (const stale of previous.values()) stale.node.destroyRecursively();
    if (!same) this.place(next.map(entry => entry.item.node), kept);
    this.built = next;
    this.tail.content = styledRows(tail);
    this.tail.visible = tail.length > 0;
    if (anchor !== null) {
      const release = this.body.anchor(anchor);
      this.body.afterLayout(release);
    }
  }

  private readingNode(kept: Set<BoxRenderable>): BoxRenderable | null {
    const top = this.body.viewport.screenY;
    for (const entry of this.built) if (kept.has(entry.item.node) && entry.item.node.y + entry.item.node.height > top) return entry.item.node;
    return null;
  }

  private place(nodes: BoxRenderable[], kept: Set<BoxRenderable>): void {
    const order = this.body.getChildren().filter(child => child !== this.tail);
    const keptOrder = nodes.filter(node => kept.has(node));
    const inOrder = order.length === keptOrder.length && order.every((child, i) => child === keptOrder[i]);
    if (!inOrder) for (const child of order) this.body.remove(child);
    let after: BoxRenderable | TextRenderable = this.tail;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (node === undefined) continue;
      if (!inOrder || !kept.has(node)) this.body.insertBefore(node, after);
      after = node;
    }
  }

  private build(item: screens.ScreenItem): BoxRenderable {
    const box = new BoxRenderable(this.ctx, { flexDirection: "column", marginTop: item.gap ? 1 : 0, flexShrink: 0 });
    if (item.kind === "rows") box.add(this.rows(item.rows));
    else if (item.kind === "user") box.add(this.user(item));
    else box.add(this.fold(item));
    return box;
  }

  private rows(rows: string[]): TextRenderable {
    const text = new TextRenderable(this.ctx, { content: styledRows(rows), wrapMode: "none", selectable: true });
    let hovered: { row: number; span: LinkSpan } | null = null;
    const hover = (next: { row: number; span: LinkSpan } | null): void => {
      if (next?.row === hovered?.row && next?.span.start === hovered?.span.start && next?.span.url === hovered?.span.url) return;
      hovered = next;
      text.content = styledRows(next === null ? rows : rows.map((row, i) => i === next.row ? underlineSpan(row, next.span) : row));
    };
    text.onMouseMove = (event: MouseEvent) => {
      const index = event.y - text.y, row = rows[index];
      const span = row === undefined ? undefined : linkSpanAt(row, event.x - text.x);
      hover(span === undefined ? null : { row: index, span });
    };
    text.onMouseOut = () => { hover(null); };
    text.onMouseDown = (event: MouseEvent) => { this.pressed = { x: event.x, y: event.y }; };
    text.onMouseUp = (event: MouseEvent) => { this.click(event, () => {
      const row = rows[event.y - text.y];
      if (row === undefined) return;
      const url = linkAt(row, event.x - text.x);
      if (url !== undefined) this.events.action({ kind: "link", url });
    }); };
    return text;
  }

  private user(item: Extract<screens.ScreenItem, { kind: "user" }>): BoxRenderable {
    const line = new BoxRenderable(this.ctx, { flexDirection: "row", justifyContent: "flex-end", marginY: 1, flexShrink: 0 });
    const block = new BoxRenderable(this.ctx, { backgroundColor: fillColour(item.fill) ?? COLOURS.surface, paddingX: 2, paddingY: 1, width: "78%", flexShrink: 0 });
    block.add(new TextRenderable(this.ctx, { content: item.rows.join("\n"), fg: COLOURS.text, wrapMode: "word", selectable: true }));
    if (item.more > 0) {
      const label = item.open ? "▾ show less" : `▸ ${item.more} more line${item.more === 1 ? "" : "s"}`;
      const toggle = new TextRenderable(this.ctx, { content: styled([chunk(label, COLOURS.muted)]), wrapMode: "none" });
      toggle.onMouseDown = (event: MouseEvent) => { this.pressed = { x: event.x, y: event.y }; };
      toggle.onMouseUp = (event: MouseEvent) => { this.click(event, () => { this.events.action({ kind: "toggle", key: item.key }); }); };
      block.add(toggle);
    }
    line.add(block);
    return line;
  }

  private fold(item: Extract<screens.ScreenItem, { kind: "fold" }>): CollapsibleRootRenderable {
    const root = new CollapsibleRootRenderable(this.ctx, { flexDirection: "column", open: item.open, onOpenChange: () => { this.events.action({ kind: "toggle", key: item.key }); } });
    const head = new BoxRenderable(this.ctx, { flexDirection: "row" });
    const trigger = new CollapsibleTriggerRenderable(this.ctx, { store: root.store, flexDirection: "row" });
    trigger.add(new TextRenderable(this.ctx, { content: styled([chunk(item.open ? "▾ " : "▸ ", COLOURS.faint), chunk(item.title, COLOURS.muted)]), wrapMode: "none" }));
    head.add(trigger);
    if (item.failed.length > 0) head.add(new TextRenderable(this.ctx, { content: styled([chunk(item.failed, COLOURS.red)]), wrapMode: "none" }));
    root.add(head);
    const panel = new CollapsiblePanelRenderable(this.ctx, { store: root.store, flexDirection: "column", paddingLeft: 2 });
    const opens = item.opens;
    if (opens === null) panel.add(this.rows(item.rows));
    else item.rows.forEach((row, index) => { panel.add(this.opener(row, opens, index)); });
    root.add(panel);
    return root;
  }

  private opener(row: string, tab: screens.OpenTab, index: number): TextRenderable {
    const text = new TextRenderable(this.ctx, { content: styledRows([row]), wrapMode: "none", selectable: true });
    text.onMouseDown = (event: MouseEvent) => { this.pressed = { x: event.x, y: event.y }; };
    text.onMouseUp = (event: MouseEvent) => { this.click(event, () => { this.events.action({ kind: "open", tab, index }); }); };
    return text;
  }

  private click(event: MouseEvent, then: () => void): void {
    const down = this.pressed;
    this.pressed = null;
    if (down !== null && down.x === event.x && down.y === event.y) then();
  }
}
