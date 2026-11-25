import { errorMessage, fail, ok, type Result } from "../../config";
import { createCliRenderer, NativeSession, type CliRenderer, type CliRendererConfig, type KeyEvent, type PasteEvent } from "@opentui/core";
import { BG_REPLY_MS, imageProtocol, keyLog, plainText, useTerminalBackground, type Key, type Terminal, type screens } from "../components";
import { Display, type ScrollBy } from "./display";
import { keyFrom, pasteFrom } from "./keys";

export type PaintingTerminal = Terminal & { released: Promise<void>; launched: Promise<Result<null>> };

type Live = { renderer: CliRenderer; display: Display; raw: Raw };
type Raw = (bytes: Uint8Array) => boolean;
export type Launched = { renderer: CliRenderer; raw: Raw };

type Output = { write: (text: string) => unknown; columns: number | undefined; rows: number | undefined; isTTY: boolean | undefined };
type Input = { isTTY: boolean | undefined };

export type Launch = (config: CliRendererConfig) => Promise<Launched>;

const launchNative: Launch = async config => {
  const session = new NativeSession(process.stdout);
  try {
    const renderer = await createCliRenderer({ ...config, nativeSession: session });
    return { renderer, raw: bytes => session.open && session.write(bytes) };
  } catch (error) {
    if (!session.disposed) await session.close().catch(() => undefined);
    throw error;
  }
};

type Event = "SIGTERM" | "SIGHUP" | "uncaughtException";
type Listener = (reason: unknown) => void;
export type Proc = { on: (event: Event, listener: Listener) => unknown; off: (event: Event, listener: Listener) => unknown; exit: (code: number) => void; stderr: { write: (text: string) => unknown } };

const realProc: Proc = {
  on: (event, listener) => process.on(event, listener),
  off: (event, listener) => process.off(event, listener),
  exit: code => { process.exit(code); },
  stderr: process.stderr,
};

const HEX = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i;

export function hexColor(hex: string): { r: number; g: number; b: number } | null {
  const match = HEX.exec(hex);
  if (match === null) return null;
  const [, r, g, b] = match;
  if (r === undefined || g === undefined || b === undefined) return null;
  return { r: parseInt(r, 16), g: parseInt(g, 16), b: parseInt(b, 16) };
}

const size = (value: number | undefined, fallback: number): number => value !== undefined && value > 0 ? value : fallback;

export function openTuiTerminal(launch: Launch = launchNative, stdin: Input = process.stdin, stdout: Output = process.stdout, proc: Proc = realProc): Result<PaintingTerminal> {
  if (stdin.isTTY !== true || stdout.isTTY !== true) return fail("orca2 start needs a terminal; run it from an interactive shell");
  return ok(new OpenTuiTerminal(launch, stdout, proc));
}

class OpenTuiTerminal implements PaintingTerminal {
  cols: number;
  rows: number;
  inlineImages = false;
  imageCell: { width: number; height: number } | undefined = undefined;
  imageProtocol: "kitty" | null = imageProtocol(process.env);
  released: Promise<void> = Promise.resolve();
  private readonly launchDone = Promise.withResolvers<Result<null>>();
  readonly launched: Promise<Result<null>> = this.launchDone.promise;
  private live: Live | null = null;
  private opened = false;
  private shut = false;
  private latest: screens.Screen | null = null;
  private title = "";
  private readonly keyHandlers: ((key: Key) => void)[] = [];
  private readonly resizeHandlers: (() => void)[] = [];
  private readonly actionHandlers: ((action: screens.ScreenAction) => void)[] = [];
  private readonly handlers: [Event, Listener][] = [
    ["SIGTERM", () => { this.die(143); }],
    ["SIGHUP", () => { this.die(129); }],
    ["uncaughtException", (reason: unknown) => { this.crash(reason); }],
  ];

  constructor(private readonly launch: Launch, private readonly stdout: Output, private readonly proc: Proc) {
    this.cols = size(stdout.columns, 80);
    this.rows = size(stdout.rows, 24);
  }

  write(text: string): void { this.stdout.write(text); }
  eraseOnExit(): void {}
  onKey(handler: (key: Key) => void): void { this.keyHandlers.push(handler); }
  onResize(handler: () => void): void { this.resizeHandlers.push(handler); }

  setTitle(title: string): void {
    this.title = plainText(title);
    if (this.live !== null) this.live.renderer.setTerminalTitle(this.title);
  }

  onAction(handler: (action: screens.ScreenAction) => void): void { this.actionHandlers.push(handler); }

  signal(sequence: string): boolean {
    if (this.live === null || this.shut || sequence.length === 0) return false;
    try { return this.live.raw(new TextEncoder().encode(sequence)); } catch { return false; }
  }

  answersStatus(): boolean {
    return this.live?.renderer.capabilities?.program_status === true;
  }

  show(screen: screens.Screen): void {
    this.latest = screen;
    if (this.live !== null) this.live.display.show(screen);
  }

  scroll(by: ScrollBy): void {
    if (this.live !== null) this.live.display.scroll(by);
  }

  selection(): string {
    return this.live === null ? "" : this.live.display.selection();
  }

  copyOsc52(text: string): boolean {
    return this.live !== null && this.live.renderer.copyToClipboardOSC52(text);
  }

  async handOver(argv: string[]): Promise<number> {
    const renderer = this.live?.renderer ?? null;
    if (renderer !== null) await renderer.suspend();
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "TMUX" && key !== "TMUX_PANE"));
      return await Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env }).exited;
    } finally {
      if (renderer !== null) await renderer.resume();
      if (this.latest !== null) this.live?.display.show(this.latest);
    }
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    for (const [event, listener] of this.handlers) this.proc.on(event, listener);
    this.start().then(() => { this.launchDone.resolve(ok(null)); }, (error: unknown) => {
      this.shut = true;
      this.launchDone.resolve(fail(`terminal renderer did not start: ${errorMessage(error)}`));
    });
  }

  close(): void {
    if (this.shut) return;
    this.shut = true;
    for (const [event, listener] of this.handlers) this.proc.off(event, listener);
    const live = this.live;
    this.live = null;
    if (live === null) return;
    live.renderer.destroy();
    this.released = live.renderer.closed.catch(() => undefined);
  }

  private async start(): Promise<void> {
    const { renderer, raw } = await this.launch({ exitOnCtrlC: false, exitSignals: [], useMouse: true, autoFocus: false, screenMode: "alternate-screen", useKittyKeyboard: { disambiguate: true, alternateKeys: true } });
    if (this.shut) { renderer.destroy(); return; }
    const display = new Display(renderer, action => { this.act(action); }, key => { this.emit(key); });
    renderer.keyInput.on("keypress", (event: KeyEvent) => { this.key(event); });
    renderer.keyInput.on("paste", (event: PasteEvent) => { this.emit(pasteFrom(event.bytes)); });
    renderer.on("resize", (width: number, height: number) => { this.resized(width, height); });
    this.live = { renderer, display, raw };
    this.cols = renderer.width;
    this.rows = renderer.height;
    if (this.title.length > 0) renderer.setTerminalTitle(this.title);
    if (this.latest !== null) display.show(this.latest);
    await this.detect(renderer);
  }

  private async detect(renderer: CliRenderer): Promise<void> {
    const palette = await renderer.getPalette({ timeout: BG_REPLY_MS }).catch(() => null);
    const hex = palette === null ? null : palette.defaultBackground;
    const background = typeof hex === "string" ? hexColor(hex) : null;
    if (background !== null) useTerminalBackground(background);
    keyLog(`start kittyKeyboard=${String(renderer.useKittyKeyboard)} capabilities=${JSON.stringify(renderer.capabilities)}`);
    this.images(renderer);
  }

  private images(renderer: CliRenderer): void {
    const resolution = renderer.resolution;
    const kitty = renderer.capabilities?.kitty_graphics === true;
    if (!kitty || resolution === null || this.cols <= 0 || this.rows <= 0) return;
    this.inlineImages = true;
    this.imageCell = { width: resolution.width / this.cols, height: resolution.height / this.rows };
  }

  private die(code: number): void {
    this.close();
    this.proc.exit(code);
  }

  private crash(reason: unknown): void {
    this.close();
    this.proc.stderr.write(`${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
    this.proc.exit(1);
  }

  private key(event: KeyEvent): void {
    const key = keyFrom(event);
    keyLog(`key raw=${JSON.stringify(event.raw)} name=${event.name} ctrl=${String(event.ctrl)} alt=${String(event.meta || event.option)} shift=${String(event.shift)} super=${String(event.super === true)} type=${event.eventType} source=${event.source} -> ${JSON.stringify(key)}`);
    this.emit(key);
  }

  private act(action: screens.ScreenAction): void {
    if (this.shut) return;
    for (const handler of this.actionHandlers) handler(action);
  }

  private emit(key: Key | null): void {
    if (key === null || this.shut) return;
    for (const handler of this.keyHandlers) handler(key);
  }

  private resized(width: number, height: number): void {
    this.cols = width;
    this.rows = height;
    if (this.live !== null) this.images(this.live.renderer);
    for (const handler of this.resizeHandlers) handler();
  }
}
