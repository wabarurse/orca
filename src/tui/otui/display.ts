import { RGBA, TextRenderable, type CliRenderer, type MouseEvent, type Selection } from "@opentui/core";
import type { Key, screens } from "../components";
import { styledRows } from "./ansi";
import { ChatView } from "./chat";
import { mouseFrom } from "./keys";

export type ScrollBy = "up" | "down" | "page-up" | "page-down" | "home" | "end";

export class Display {
  private readonly chat: ChatView;
  private readonly page: TextRenderable;
  private shown: screens.Screen | null = null;

  constructor(private readonly renderer: CliRenderer, private readonly act: (action: screens.ScreenAction) => void, private readonly key: (key: Key) => void) {
    this.chat = new ChatView(renderer, { action: act });
    this.page = new TextRenderable(renderer, { content: "", fg: RGBA.defaultForeground(), width: "100%", height: "100%", wrapMode: "none", selectable: true, visible: false });
    this.page.onMouse = (event: MouseEvent) => { this.mouse(event); };
    renderer.root.add(this.chat.root);
    renderer.root.add(this.page);
    renderer.on("selection", (selection: Selection | null) => { this.selected(selection); });
  }

  show(screen: screens.Screen): void {
    this.shown = screen;
    if (screen.kind === "page") {
      this.chat.root.visible = false;
      this.page.visible = true;
      this.page.content = styledRows(screen.rows);
      this.renderer.setCursorPosition(screen.col + 1, screen.cursor + 1, true);
    } else {
      this.page.visible = false;
      this.chat.root.visible = true;
      this.chat.show(screen, this.renderer.width);
      const cursor = screen.cursor;
      const top = this.renderer.height - this.chat.footerRows();
      if (cursor === null) this.renderer.setCursorPosition(1, 1, false);
      else this.renderer.setCursorPosition(cursor.col + 1, top + cursor.row + 1, true);
    }
    this.renderer.requestRender();
  }

  scroll(by: ScrollBy): void {
    if (this.shown === null || this.shown.kind !== "chat") return;
    this.chat.scroll(by);
    this.renderer.requestRender();
  }

  selection(): string {
    const selection = this.renderer.getSelection();
    return selection === null ? "" : selection.getSelectedText();
  }

  private selected(selection: Selection | null): void {
    if (selection === null) return;
    const text = selection.getSelectedText();
    if (text.length > 0) this.act({ kind: "copy", text });
  }

  private mouse(event: MouseEvent): void {
    const key = mouseFrom(event);
    if (key !== null) this.key(key);
  }
}
