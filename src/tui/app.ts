// The full-screen TUI. One page per orchestrator (one per project): Ctrl+N
// opens a new one, Ctrl+, and Ctrl+. move between them (Alt+, / Alt+. where
// the terminal cannot tell Ctrl+, apart from a comma). Type to talk to the
// page's orchestrator; worker and reviewer reports arrive through its inbox
// and show up while you wait. Slash commands open arrow-key menus.

import { accountChoices, listAgents, listProjects, login, modelChoices, setModel, useAccount, type Choice } from "../commands";
import { paths } from "../config";
import type { Orchestrator } from "../orchestrator";
import { follow } from "../view";
import type { Key } from "./keys";
import { bold, dim, render, type Frame, type Menu } from "./render";
import type { Terminal } from "./term";

export interface Page {
  project: string;
  orch: Orchestrator;
  /** Scrollback, oldest first. */
  lines: string[];
  /** Streamed text that has not reached a newline yet. */
  partial: string;
  busy: boolean;
  /** Set while an agent's transcript is showing; calling leave returns to the page. */
  view: { name: string; lines: string[]; leave: () => void } | null;
}

export interface AppDeps {
  term: Terminal;
  /** Make sure the project exists (cloning when a url is given) and build its orchestrator. */
  openOrchestrator(project: string, url: string | undefined, write: (text: string) => void): Promise<Orchestrator>;
  /** Inbox poll period; tests shorten it. */
  pollMs?: number;
}

interface Prompt { label: string; submit: (text: string) => Promise<void> | void }
interface ActiveMenu extends Menu { pick: (index: number) => Promise<void> | void }

const HINTS = "^N new   ^, ^. switch   /agents /models /accounts /login /close /quit   PgUp PgDn scroll";

export class App {
  pages: Page[] = [];
  active = 0;
  input = { text: "", cursor: 0 };
  scroll = 0;
  menu: ActiveMenu | null = null;
  prompt: Prompt | null = null;
  status = HINTS;
  loggingIn = false;
  private history: string[] = [];
  private historyAt = -1;
  private done!: () => void;
  private readonly finished: Promise<void>;
  private readonly loginAbort = new AbortController();
  private frameQueued = false;

  constructor(private readonly deps: AppDeps) {
    this.finished = new Promise<void>((r) => (this.done = r));
  }

  get page(): Page | undefined { return this.pages[this.active]; }

  /** Run until /quit; opens the given project, or every known one, or the new-page prompt. */
  async run(project?: string, url?: string): Promise<void> {
    const { term } = this.deps;
    term.open();
    term.onKey((k) => { this.onKey(k).catch((err) => this.say(`error: ${err instanceof Error ? err.message : String(err)}`)); });
    term.onResize(() => this.draw());
    const poll = setInterval(() => {
      for (const p of this.pages) if (!p.busy && !this.loggingIn) p.orch.pending().then((has) => { if (has) this.runTurn(p); }).catch(() => {});
    }, this.deps.pollMs ?? 2000);
    try {
      if (project) await this.openPage(project, url);
      else {
        for (const name of await listProjects()) await this.openPage(name);
        if (!this.pages.length) this.newPagePrompt();
      }
      this.draw();
      await this.finished;
    } finally {
      clearInterval(poll);
      this.loginAbort.abort();
      for (const p of this.pages) p.view?.leave();
      term.close();
    }
  }

  quit(): void { this.done(); }

  // --- output -----------------------------------------------------------------

  /** Append a finished line to the active page (or the screen when there is none). */
  say(line: string, page = this.page): void {
    if (page) (page.view?.lines ?? page.lines).push(line);
    else this.status = line;
    this.draw();
  }

  /** Streamed model text: lines end at newlines, the rest waits in `partial`. */
  private stream(page: Page, text: string): void {
    const parts = (page.partial + text).split("\n");
    page.partial = parts.pop()!;
    page.lines.push(...parts);
    this.draw();
  }

  frame(): Frame {
    const page = this.page;
    const body = page ? (page.view ? page.view.lines : page.partial ? [...page.lines, page.partial] : page.lines) : [];
    const prompt = this.prompt ? `${this.prompt.label} ` : page?.view ? dim(`${page.view.name} > `) : dim("> ");
    return {
      cols: this.deps.term.cols, rows: this.deps.term.rows,
      tabs: this.pages.map((p, i) => ({ title: p.view ? `${p.project} › ${p.view.name}` : p.project, active: i === this.active, busy: p.busy })),
      lines: body, scroll: this.scroll, status: this.status,
      input: { prompt, text: this.input.text, cursor: this.input.cursor },
      menu: this.menu,
    };
  }

  draw(): void {
    if (this.frameQueued) return;
    this.frameQueued = true;
    setTimeout(() => { this.frameQueued = false; this.deps.term.write(render(this.frame())); }, 0);
  }

  // --- pages ------------------------------------------------------------------

  async openPage(project: string, url?: string): Promise<Page> {
    const existing = this.pages.findIndex((p) => p.project === project);
    if (existing !== -1) { this.active = existing; this.draw(); return this.pages[existing]!; }
    const page: Page = { project, orch: null as unknown as Orchestrator, lines: [], partial: "", busy: false, view: null };
    page.orch = await this.deps.openOrchestrator(project, url, (text) => this.stream(page, text));
    page.lines.push(dim(`${bold(project)}  ${paths.repo(project)}`));
    this.pages.push(page);
    this.active = this.pages.length - 1;
    this.scroll = 0;
    this.draw();
    return page;
  }

  closePage(): void {
    const page = this.page;
    if (!page) return;
    page.view?.leave();
    this.pages.splice(this.active, 1);
    this.active = Math.min(this.active, Math.max(0, this.pages.length - 1));
    this.scroll = 0;
    this.draw();
  }

  switchPage(delta: number): void {
    if (this.pages.length < 2) return;
    this.active = (this.active + delta + this.pages.length) % this.pages.length;
    this.scroll = 0;
    this.draw();
  }

  newPagePrompt(): void {
    this.prompt = {
      label: bold("new orchestrator:") + dim(" <project> [git-url]"),
      submit: async (text) => {
        const [project, url] = text.split(/\s+/).filter(Boolean);
        if (!project) return;
        this.status = `opening ${project}…`;
        this.draw();
        try { await this.openPage(project, url); }
        catch (err) { this.say(`error: ${err instanceof Error ? err.message : String(err)}`); }
        this.status = HINTS;
      },
    };
    this.draw();
  }

  private async runTurn(page: Page): Promise<void> {
    if (page.busy) return;
    page.busy = true;
    this.draw();
    try {
      for (const reply of await page.orch.turn()) {
        if (page.partial) { page.lines.push(page.partial); page.partial = ""; }
        page.lines.push(`${bold(reply.from)} ${reply.text}`);
      }
    } catch (err) {
      page.lines.push(`${bold("error")} ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (page.partial) { page.lines.push(page.partial); page.partial = ""; }
      page.busy = false;
      this.draw();
    }
  }

  // --- menus ------------------------------------------------------------------

  openMenu<T>(title: string, choices: Choice<T>[], pick: (value: T) => Promise<void> | void): void {
    if (!choices.length) return;
    this.menu = {
      title: dim(title) + dim("   ↑↓ Enter   Esc cancels"),
      items: choices.map((c) => `${c.current ? "●" : " "} ${c.label}`),
      index: Math.max(0, choices.findIndex((c) => c.current)),
      pick: (i) => pick(choices[i]!.value),
    };
    this.draw();
  }

  private async agentsMenu(page: Page): Promise<void> {
    const agents = await listAgents(page.project);
    if (!agents.length) return this.say(dim("no agents yet"));
    this.openMenu("attach to an agent", agents.map((a) => ({ value: a.name, label: `${a.name}  ${dim(a.live ? "live" : "finished")}` })), (name) => this.attach(page, name));
  }

  private async accountsMenu(): Promise<void> {
    this.openMenu("accounts: Enter uses one or signs it in", await accountChoices(dim), async (account) => {
      if (account.ok) return this.say(dim(await useAccount(account)));
      await this.login(`${account.provider} ${account.id.split(":")[1]}`);
    });
  }

  private async modelsMenu(): Promise<void> {
    this.status = "fetching models…";
    this.draw();
    const { choices, errors } = await modelChoices(dim);
    this.status = HINTS;
    for (const e of errors) this.say(dim(e));
    if (!choices.length) return this.say(dim("no models available; sign in with /login first"));
    this.openMenu("switch model   (/models <id> for any other id)", choices, async (id) => this.say(dim(await setModel(id))));
  }

  private async attach(page: Page, name: string): Promise<void> {
    const stopped = new Promise<void>((r) => (page.view = { name, lines: [], leave: r }));
    const view = page.view!;
    this.scroll = 0;
    this.say(dim("Esc or /back returns"), page);
    await follow(paths.transcript(page.project, name), (s) => { view.lines.push(s); this.draw(); }, stopped);
    page.view = null;
    this.draw();
  }

  private async login(arg: string): Promise<void> {
    this.loggingIn = true;
    this.status = "signing in… (/quit cancels)";
    this.draw();
    try { this.say(await login(arg, { write: (s) => this.say(s.replace(/\n$/, "")), signal: this.loginAbort.signal })); }
    catch (err) { this.say(`login failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { this.loggingIn = false; this.status = HINTS; this.draw(); }
  }

  // --- input ------------------------------------------------------------------

  private async submit(text: string): Promise<void> {
    const page = this.page;
    if (text === "/quit") return this.quit();
    if (this.loggingIn) return;
    if (page?.view) {
      if (text === "/back") page.view.leave();
      return;
    }
    if (text === "/new") return this.newPagePrompt();
    if (text.startsWith("/new ")) return this.newPagePrompt(), this.prompt!.submit(text.slice(5));
    if (text === "/close") return this.closePage();
    if (text === "/login" || text.startsWith("/login ")) return this.login(text.slice(6).trim());
    if (text === "/accounts") return this.accountsMenu();
    if (text === "/models") return this.modelsMenu();
    if (text.startsWith("/models ")) return this.say(dim(await setModel(text.slice(8).trim())));
    if (!page) return this.say(dim("no orchestrator open; ^N starts one"));
    if (text === "/agents") return this.agentsMenu(page);
    if (text.startsWith("/")) return this.say(dim(`unknown command ${text.split(" ")[0]}`));
    page.lines.push(`${bold(">")} ${text}`);
    await page.orch.say(text);
    this.runTurn(page);
  }

  async onKey(k: Key): Promise<void> {
    // Chords that work everywhere.
    if (k.ctrl && k.name === "c") return this.quit();
    if (k.ctrl && k.name === "n") return this.newPagePrompt();
    if ((k.ctrl || k.alt) && k.name === ",") return this.switchPage(-1);
    if ((k.ctrl || k.alt) && k.name === ".") return this.switchPage(1);
    if (k.name === "pageup") { this.scroll += Math.max(1, this.deps.term.rows - 4); return this.draw(); }
    if (k.name === "pagedown") { this.scroll = Math.max(0, this.scroll - Math.max(1, this.deps.term.rows - 4)); return this.draw(); }

    if (this.menu) {
      const m = this.menu;
      if (k.name === "up" || (k.ctrl && k.name === "p") || (k.name === "char" && k.text === "k")) m.index = (m.index + m.items.length - 1) % m.items.length;
      else if (k.name === "down" || (k.name === "char" && k.text === "j")) m.index = (m.index + 1) % m.items.length;
      else if (k.name === "enter") { this.menu = null; await m.pick(m.index); }
      else if (k.name === "escape" || (k.name === "char" && k.text === "q")) this.menu = null;
      return this.draw();
    }
    if (k.name === "escape") {
      if (this.prompt) this.prompt = null;
      else if (this.page?.view) this.page.view.leave();
      else this.input = { text: "", cursor: 0 };
      return this.draw();
    }
    if (k.name === "enter") {
      const text = this.input.text.trim();
      this.input = { text: "", cursor: 0 };
      this.scroll = 0;
      this.historyAt = -1;
      const prompt = this.prompt;
      if (prompt) { this.prompt = null; this.draw(); return prompt.submit(text); }
      if (!text) return this.draw();
      this.history.unshift(text);
      this.draw();
      return this.submit(text);
    }
    this.edit(k);
    this.draw();
  }

  /** Plain line editing on the input field. */
  private edit(k: Key): void {
    const { text, cursor } = this.input;
    if (k.name === "char" && k.text && !k.ctrl && !k.alt) this.input = { text: text.slice(0, cursor) + k.text + text.slice(cursor), cursor: cursor + k.text.length };
    else if (k.name === "backspace" && cursor > 0) this.input = { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
    else if (k.name === "delete") this.input = { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
    else if (k.name === "left") this.input.cursor = Math.max(0, cursor - 1);
    else if (k.name === "right") this.input.cursor = Math.min(text.length, cursor + 1);
    else if (k.name === "home" || (k.ctrl && k.name === "a")) this.input.cursor = 0;
    else if (k.name === "end" || (k.ctrl && k.name === "e")) this.input.cursor = text.length;
    else if (k.ctrl && k.name === "u") this.input = { text: text.slice(cursor), cursor: 0 };
    else if (k.ctrl && k.name === "k") this.input = { text: text.slice(0, cursor), cursor };
    else if (k.ctrl && k.name === "w") {
      const head = text.slice(0, cursor).replace(/\S+\s*$/, "");
      this.input = { text: head + text.slice(cursor), cursor: head.length };
    } else if (k.name === "up" && !this.prompt && this.historyAt + 1 < this.history.length) {
      this.historyAt++;
      const t = this.history[this.historyAt]!;
      this.input = { text: t, cursor: t.length };
    } else if (k.name === "down" && !this.prompt && this.historyAt >= 0) {
      this.historyAt--;
      const t = this.historyAt === -1 ? "" : this.history[this.historyAt]!;
      this.input = { text: t, cursor: t.length };
    }
  }
}
