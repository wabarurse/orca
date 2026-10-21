// The full-screen TUI, kept bare: a tab bar, the page, an input line. One
// page per orchestrator (one per project): Ctrl+N starts a new one named
// orch-xxxx (/rename gives it a display name), Ctrl+Z and Ctrl+X move between them. Type to
// talk to the page's orchestrator; worker and reviewer reports arrive through
// its inbox and show up while you wait. /help lists the commands.

import { accountChoices, displayName, listAgents, liveAgents, listProjects, login, modelChoices, newProjectName, projectFor, remoteOf, setDisplayName, setModel, shortRemote, useAccount, validProjectName, type Choice } from "../commands";
import { homedir } from "node:os";
import { paths } from "../config";
import type { Orchestrator } from "../orchestrator";
import { follow } from "../view";
import type { Key } from "./keys";
import { bold, dim, render, type Frame, type Menu } from "./render";
import type { Terminal } from "./term";

export interface Page {
  /** The project id: its folder under ~/.parallels/projects. Never changes. */
  project: string;
  /** What tabs and the header show; /rename sets it. */
  name: string;
  orch: Orchestrator;
  /** Where the clone came from, for the header. */
  remote: string;
  /** Scrollback, oldest first. */
  lines: string[];
  /** Streamed text that has not reached a newline yet. */
  partial: string;
  busy: boolean;
  /** When the running turn started (clock ms), and whether its text has started streaming. */
  busySince: number;
  streamed: boolean;
  /** Set while an agent's transcript is showing; calling leave returns to the page. */
  view: { name: string; lines: string[]; leave: () => void; live: boolean } | null;
}

export interface AppDeps {
  term: Terminal;
  /** Make sure the project exists (cloning when a url is given) and build its orchestrator. */
  openOrchestrator(project: string, url: string | undefined, write: (text: string) => void): Promise<Orchestrator>;
  /** Inbox poll period; tests shorten it. */
  pollMs?: number;
  /** Clone source of the repository `start` was run from, if any: opened on start and cloned by Ctrl+N. */
  source?: string | null;
  /** Clock and repeating timer for the busy spinner; tests inject fakes so they never sleep. */
  clock?: Clock;
  /** A project's agents and which are live: /agents lists these and live views poll them. Defaults to listAgents for the menu and to tmux alone (liveAgents) for the poll. */
  agents?: (project: string) => Promise<{ name: string; live: boolean }[]>;
  /** Sign-in; tests replace it. */
  login?: typeof login;
}

export interface Clock { now(): number; every(fn: () => void, ms: number): () => void }

const realClock: Clock = {
  now: () => Date.now(),
  every: (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
};

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const SPIN_MS = 100;
/** How often a live agent view checks whether its agent has finished. */
const LIVE_CHECK_MS = 1000;

interface ActiveMenu extends Menu { pick: (index: number) => Promise<void> | void }

const HELP = [
  "^N new orchestrator   ^Z ^X switch pages   PgUp PgDn scroll   Esc clear",
  "/keys shows what your terminal sends for a chord (Esc ends)",
  "/rename <name>   /new [name] [git-url]   /close closes this page   /quit",
  "/agents   /models [id]   /accounts   /login claude|codex [profile]",
];
const HELP_VIEW = "/back (or Esc) leaves the agent view";

/** A page shows activity while its turn runs or its agent view follows a live agent. */
const active = (p: Page) => p.busy || !!p.view?.live;

export class App {
  pages: Page[] = [];
  active = 0;
  input = { text: "", cursor: 0 };
  scroll = 0;
  menu: ActiveMenu | null = null;
  loggingIn = false;
  /** Text typed while signing in, per page; sent when sign-in succeeds, dropped when it fails. */
  private readonly queued = new Map<Page, string[]>();
  /** /keys: echo every key as parsed until Esc, to see what a terminal really sends. */
  keyEcho = false;
  private history: string[] = [];
  private historyAt = -1;
  private done!: () => void;
  private readonly finished: Promise<void>;
  private readonly loginAbort = new AbortController();
  private frameQueued = false;
  private stopSpinner: (() => void) | null = null;
  private liveCheckedAt = 0;
  /** Liveness checks still running, per project; a tick skips a project while its last check is pending. */
  private readonly liveChecks = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly deps: AppDeps) {
    this.finished = new Promise<void>((r) => (this.done = r));
  }

  get page(): Page | undefined { return this.pages[this.active]; }

  private get clock(): Clock { return this.deps.clock ?? realClock; }

  /** Run until /quit; opens the given project, or every known one plus the repo we were started in, or a fresh orch-xxxx. */
  async run(project?: string, url?: string): Promise<void> {
    const { term } = this.deps;
    term.open();
    term.onKey((k) => { this.onKey(k).catch((err) => this.say(`error: ${err instanceof Error ? err.message : String(err)}`)); });
    term.onResize(() => this.draw());
    const poll = setInterval(() => {
      if (!this.loggingIn) this.runPending();
    }, this.deps.pollMs ?? 2000);
    try {
      if (project) await this.openPage(project, url);
      else {
        for (const name of await listProjects()) await this.openPage(name);
        const source = this.deps.source;
        if (source) {
          // Reuse the project already cloned from this repo, else start a fresh orch-xxxx on it.
          const existing = await projectFor(source);
          if (existing) await this.openPage(existing);
          else await this.newPage();
        }
        if (!this.pages.length) await this.newPage();
      }
      this.draw();
      await this.finished;
    } finally {
      clearInterval(poll);
      this.closed = true;
      this.stopSpinner?.();
      this.stopSpinner = null;
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
    this.draw();
  }

  /** Streamed model text: lines end at newlines, the rest waits in `partial`. */
  private stream(page: Page, text: string): void {
    const parts = (page.partial + text).split("\n");
    page.partial = parts.pop()!;
    page.streamed = true;
    page.lines.push(...parts);
    this.draw();
  }

  frame(): Frame {
    const page = this.page;
    const body = page ? (page.view ? page.view.lines : page.partial ? [...page.lines, page.partial] : page.lines) : [];
    const prompt = page?.view ? dim(`${page.view.name} > `) : dim("> ");
    const header = page ? dim(`${page.name}  ·  ${paths.repo(page.project).replace(homedir(), "~")}  ·  ${shortRemote(page.remote)}`) : "";
    return {
      cols: this.deps.term.cols, rows: this.deps.term.rows, header,
      tabs: this.pages.map((p, i) => ({ title: p.view ? `${p.name} › ${p.view.name}` : p.name, active: i === this.active, busy: active(p), spinner: this.spinner() })),
      lines: body, scroll: this.scroll, status: page ? this.status(page) : null,
      input: { prompt, text: this.input.text, cursor: this.input.cursor },
      menu: this.menu,
    };
  }

  private spinner(): string { return SPINNER[Math.floor(this.clock.now() / SPIN_MS) % SPINNER.length]!; }

  /** The dimmed line above the input while the page's turn (or the viewed agent) runs. */
  private status(page: Page): string | null {
    // A live agent view wins over the page's own turn; otherwise a busy page shows its turn, view or not.
    if (page.view?.live) return dim(`${this.spinner()} following ${page.view.name}`);
    if (!page.busy) return null;
    const secs = Math.floor((this.clock.now() - page.busySince) / 1000);
    return dim(`${this.spinner()} ${page.streamed ? "working…" : "thinking…"} ${secs}s`);
  }

  /** Run the spinner timer only while some page is busy or viewing a live agent. */
  private animate(): void {
    const want = !this.closed && this.pages.some(active);
    if (want && !this.stopSpinner) this.stopSpinner = this.clock.every(() => this.tick(), SPIN_MS);
    else if (!want && this.stopSpinner) { this.stopSpinner(); this.stopSpinner = null; }
  }

  private tick(): void {
    const now = this.clock.now();
    if (now - this.liveCheckedAt >= LIVE_CHECK_MS) {
      this.liveCheckedAt = now;
      for (const project of new Set(this.pages.filter((p) => p.view?.live).map((p) => p.project))) this.checkLive(project);
    }
    this.draw();
  }

  /** One agents call per project, never overlapping: mark views whose agent has finished. */
  private checkLive(project: string): void {
    if (this.liveChecks.has(project)) return;
    const check = (this.deps.agents ?? liveAgents)(project)
      .then((agents) => {
        const live = new Set(agents.filter((a) => a.live).map((a) => a.name));
        for (const p of this.pages) if (p.project === project && p.view?.live && !live.has(p.view.name)) { p.view.live = false; this.draw(); }
      })
      .catch(() => {})
      .finally(() => this.liveChecks.delete(project));
    this.liveChecks.set(project, check);
  }

  draw(): void {
    if (this.closed) return;
    this.animate();
    if (this.frameQueued) return;
    this.frameQueued = true;
    setTimeout(() => { this.frameQueued = false; if (!this.closed) this.deps.term.write(render(this.frame())); }, 0);
  }

  // --- pages ------------------------------------------------------------------

  async openPage(project: string, url?: string): Promise<Page> {
    const existing = this.pages.findIndex((p) => p.project === project);
    if (existing !== -1) { this.active = existing; this.draw(); return this.pages[existing]!; }
    const page: Page = { project, name: project, orch: null as unknown as Orchestrator, remote: "", lines: [], partial: "", busy: false, busySince: 0, streamed: false, view: null };
    page.orch = await this.deps.openOrchestrator(project, url, (text) => this.stream(page, text));
    page.remote = await remoteOf(project);
    page.name = await displayName(project);
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

  /** Every project id, open or on disk, with the name its tab shows, so no two tabs read the same. */
  private async shownNames(): Promise<Map<string, string>> {
    const shown = new Map<string, string>(this.pages.map((p) => [p.project, p.name]));
    for (const id of await listProjects()) if (!shown.has(id)) shown.set(id, await displayName(id));
    return shown;
  }

  /** Start a fresh orchestrator named orch-xxxx (or `name`), cloning `url`, else the repo we were started in. */
  async newPage(name?: string, url?: string): Promise<void> {
    const shown = await this.shownNames();
    if (name && [...shown].some(([id, n]) => id !== name && n === name)) return this.say(dim(`another project is already called ${name}`));
    const project = name ?? newProjectName([...shown.keys(), ...shown.values()]);
    try {
      const page = await this.openPage(project, url ?? this.deps.source ?? undefined);
      if (!name) this.say(dim("/rename <name> to rename"), page);
    } catch (err) { this.say(`error: ${err instanceof Error ? err.message : String(err)}`); }
  }

  /** Set the page's display name; the project folder, id and running agents are untouched, so this works mid-turn. */
  async renamePage(to: string): Promise<void> {
    const page = this.page;
    if (!page) return;
    if (!to) return this.say(dim("usage: /rename <name>"));
    if (this.pages.some((p) => p !== page && (p.name === to.trim() || p.project === to.trim()))) return this.say(dim(`another page is already called ${to.trim()}`));
    try {
      const from = page.name;
      page.name = await setDisplayName(page.project, to);
      this.say(dim(`${from} → ${page.name}`), page);
    } catch (err) { this.say(`error: ${err instanceof Error ? err.message : String(err)}`, page); }
  }

  private async runTurn(page: Page): Promise<void> {
    if (page.busy) return;
    page.busy = true;
    page.busySince = this.clock.now();
    page.streamed = false;
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
    const agents = await (this.deps.agents ?? listAgents)(page.project);
    if (!agents.length) return this.say(dim("no agents yet"));
    this.openMenu("attach to an agent", agents.map((a) => ({ value: a.name, label: `${a.name}  ${dim(a.live ? "live" : "finished")}` })), (name) => {
      page.view?.leave();
      return this.attach(page, name, agents.find((a) => a.name === name)?.live ?? false);
    });
  }

  private async accountsMenu(): Promise<void> {
    this.openMenu("accounts: Enter uses one or signs it in", await accountChoices(dim), async (account) => {
      if (account.ok) return this.say(dim(await useAccount(account)));
      await this.login(`${account.provider} ${account.id.split(":")[1]}`);
    });
  }

  private async modelsMenu(): Promise<void> {
    this.say(dim("fetching models…"));
    const { choices, errors } = await modelChoices(dim);
    for (const e of errors) this.say(dim(e));
    if (!choices.length) return this.say(dim("no models available; sign in with /login first"));
    this.openMenu("switch model   (/models <id> for any other id)", choices, async (id) => this.say(dim(await setModel(id))));
  }

  private async attach(page: Page, name: string, live: boolean): Promise<void> {
    const stopped = new Promise<void>((r) => (page.view = { name, lines: [], leave: r, live }));
    const view = page.view!;
    this.scroll = 0;
    this.say(dim("Esc or /back returns"), page);
    await follow(paths.transcript(page.project, name), (s) => { view.lines.push(s); this.draw(); }, stopped);
    if (page.view === view) page.view = null;
    this.draw();
  }

  /** Start a turn on every idle page whose orchestrator has unread messages. */
  private runPending(): void {
    for (const p of this.pages) if (!p.busy) p.orch.pending().then((has) => { if (has) this.runTurn(p); }).catch(() => {});
  }

  private async login(arg: string): Promise<void> {
    if (this.loggingIn) return this.say(dim("already signing in; /quit cancels"));
    this.loggingIn = true;
    this.say(dim("signing in… (/quit cancels)"));
    let ok = false;
    try {
      const result = await (this.deps.login ?? login)(arg, { write: (s) => this.say(s.replace(/\n$/, "")), signal: this.loginAbort.signal });
      ok = !result.startsWith("usage:");
      this.say(result);
    } catch (err) { this.say(`login failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { this.loggingIn = false; }
    // Text typed meanwhile was held back: send it now, or drop it when sign-in failed.
    const queued = [...this.queued];
    this.queued.clear();
    for (const [page, texts] of queued) {
      if (!this.pages.includes(page)) continue; // closed meanwhile
      if (ok) for (const t of texts) await page.orch.say(t);
      else this.say(dim(`sign-in failed; dropped ${texts.length} queued message(s)`), page);
    }
    this.draw();
    this.runPending();
  }

  // --- input ------------------------------------------------------------------

  /** Every command works at any time: mid-turn, while viewing an agent, while signing in. */
  private async submit(text: string): Promise<void> {
    const page = this.page;
    if (text === "/quit") return this.quit();
    if (text === "/back") {
      if (page?.view) return page.view.leave();
      return this.say(dim("not viewing an agent"));
    }
    if (text === "/help") { for (const l of page?.view ? [...HELP, HELP_VIEW] : HELP) this.say(dim(l)); return; }
    if (text === "/keys") { this.keyEcho = true; return this.say(dim("press keys; Esc ends")); }
    if (text === "/new" || text.startsWith("/new ")) {
      const [name, url] = text.slice(4).trim().split(/\s+/).filter(Boolean);
      if (name && !validProjectName(name)) return this.say(dim("project ids are letters, digits, . _ or -; /rename sets a free-form name"));
      return this.newPage(name, url);
    }
    if (text === "/rename" || text.startsWith("/rename ")) return this.renamePage(text.slice(7).trim());
    if (text === "/close") return this.closePage();
    if (text === "/login" || text.startsWith("/login ")) return this.login(text.slice(6).trim());
    if (text === "/accounts") return this.accountsMenu();
    if (text === "/models") return this.modelsMenu();
    if (text.startsWith("/models ")) return this.say(dim(await setModel(text.slice(8).trim())));
    if (!page) return this.newPage();
    if (text === "/agents") return this.agentsMenu(page);
    if (text.startsWith("/")) return this.say(dim(`unknown command ${text.split(" ")[0]}`));
    if (page.view) return this.say(dim(`viewing ${page.view.name}; /back first to talk to the orchestrator`));
    page.lines.push(`${bold(">")} ${text}`);
    // While signing in the text waits in the app; login() sends it only if sign-in succeeds.
    if (this.loggingIn) {
      this.queued.set(page, [...(this.queued.get(page) ?? []), text]);
      return this.say(dim("queued; runs after sign-in"), page);
    }
    await page.orch.say(text);
    this.runTurn(page);
  }

  async onKey(k: Key): Promise<void> {
    if (this.keyEcho) {
      if (k.name === "escape") { this.keyEcho = false; return this.say(dim("done")); }
      return this.say(dim(JSON.stringify(k)));
    }
    // Chords that work everywhere.
    if (k.ctrl && k.name === "c") return this.quit();
    if (k.ctrl && k.name === "n") return this.newPage();
    // Plain control bytes, so they arrive in every terminal (the TUI runs in raw mode, so ^Z does not suspend).
    if (k.ctrl && k.name === "z") return this.switchPage(-1);
    if (k.ctrl && k.name === "x") return this.switchPage(1);
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
      if (this.page?.view) this.page.view.leave();
      else this.input = { text: "", cursor: 0 };
      return this.draw();
    }
    if (k.name === "enter") {
      const text = this.input.text.trim();
      this.input = { text: "", cursor: 0 };
      this.scroll = 0;
      this.historyAt = -1;
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
    } else if (k.name === "up" && this.historyAt + 1 < this.history.length) {
      this.historyAt++;
      const t = this.history[this.historyAt]!;
      this.input = { text: t, cursor: t.length };
    } else if (k.name === "down" && this.historyAt >= 0) {
      this.historyAt--;
      const t = this.historyAt === -1 ? "" : this.history[this.historyAt]!;
      this.input = { text: t, cursor: t.length };
    }
  }
}
