// Real application/input lifecycle in a real terminal with no user state or model requests: the app runs inside a
// private tmux server, which is the terminal emulator; capture-pane reads back exactly what a person would see.
// tmux cannot inject raw mouse reports or a literal bracketed paste, so pastes use paste-buffer -p and scrolling uses
// Page Up/Down; mouse and split-write input are covered in otui/terminal.test.ts and the App tests. Skipped without tmux.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { open } from "../core/data/transcripts/transcript";
import { assertLayout } from "../config";

const TMUX = Bun.which("tmux");
let last: (() => string) | null = null;

async function until(check: () => Promise<boolean>, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(25);
  if (!(await check()) && last !== null) console.log(`pane when the wait gave up:\n${last()}`);
  expect(await check()).toBe(true);
}

/** The app in a private tmux pane: `screen()` is the visible rows, `history()` includes the scrollback. */
async function launch(home: string) {
  const sock = join(home, "t.sock");
  const tmux = (...args: string[]) => Bun.spawnSync([TMUX!, "-S", sock, "-f", "/dev/null", ...args], { env: env(home) });
  const script = `printf 'STTY_BEFORE:%s\\n' "$(stty -g)"; i=0; while [ "$i" -lt 40 ]; do printf 'PRELAUNCH_SENTINEL_%s\\n' "$i"; i=$((i + 1)); done; "$1" "$2" start probe; printf '\\nEXIT:%s\\nSTTY_AFTER:%s\\n' "$?" "$(stty -g)"; sleep 60`;
  tmux("new-session", "-d", "-c", home, "-x", "100", "-y", "24", "-s", "pty", "/bin/sh", "-c", script, "probe-shell", process.execPath, join(import.meta.dir, "..", "cli", "main.ts"));
  tmux("set-option", "-g", "history-limit", "5000");
  tmux("set-option", "-s", "escape-time", "0");
  const capture = (...args: string[]) => tmux("capture-pane", "-p", "-t", "pty", ...args).stdout.toString();
  last = () => capture();
  return {
    screen: async () => capture().split("\n").slice(0, 24),
    history: async () => capture("-J", "-S", "-5000"),
    type: (text: string) => { tmux("send-keys", "-t", "pty", "-l", text); },
    key: (name: string) => { tmux("send-keys", "-t", "pty", name); },
    paste: (text: string) => { tmux("set-buffer", text); tmux("paste-buffer", "-p", "-t", "pty"); },
    /** Vim mode: Esc leaves insert mode, then the real command exits from Vim's `:` line. */
    quit: async () => {
      tmux("send-keys", "-t", "pty", "Escape");
      await until(async () => capture().includes("[NORMAL]"));
      await Bun.sleep(100); // past the Alt window, so `:` is not read as Alt+:
      tmux("send-keys", "-t", "pty", "-l", ":quit");
      tmux("send-keys", "-t", "pty", "Enter");
    },
    /** A fresh home opens in Vim's NORMAL mode: `i` starts typing. */
    insert: async () => { if (capture().includes("[NORMAL]")) { tmux("send-keys", "-t", "pty", "-l", "i"); await until(async () => capture().includes("[INSERT]")); } },
    stop: () => {
      tmux("kill-server");
      Bun.spawnSync([TMUX!, "-S", join(home, "tmux.sock"), "kill-server"], { env: env(home) });
    },
  };
}

/** No inherited auth, git config or user project; the SSH guard keeps the host clipboard untouched. */
const env = (home: string) => ({ HOME: home, ORCA_HOME: home, PATH: `${dirname(TMUX!)}:/usr/bin:/bin`, TERM: "xterm-256color", SSH_TTY: "fixture-no-desktop", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });

async function home(write: (t: ReturnType<typeof open>) => Promise<void>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "orca-pty-"));
  assertLayout(dir);
  mkdirSync(join(dir, "projects", "probe", "repo"), { recursive: true });
  const t = open(join(dir, "projects", "probe", "transcript", "orchestrator.jsonl"));
  await t.append({ type: "meta", role: "orchestrator", model: "m" });
  await write(t);
  return dir;
}

const input = (rows: string[]) => rows.find(row => row.startsWith("│ >"))?.replace(/\s*│$/, "") ?? "";

test.skipIf(!TMUX)("owned terminal: saved history scrolls between pinned bars; exit restores the shell and prints the transcript", async () => {
  const dir = await home(async t => {
    await t.append({ type: "message", message: { role: "user", content: "PTY-ORIGINAL-HISTORY" } });
    for (let i = 0; i < 140; i++) await t.append({ type: "message", message: { role: "assistant", content: `PTY-RECORD-${i}` } });
    await t.append({ type: "summary", text: "PTY-MODEL-ONLY", retained: [], boundary: t.head() });
    await t.append({ type: "message", message: { role: "assistant", content: "PTY-LATEST-HISTORY" } });
  });
  const app = await launch(dir);
  try {
    await until(async () => (await app.screen()).some(row => row.includes("PTY-LATEST-HISTORY")));
    await app.insert();
    app.paste("PTY-DRAFT\nsecond line");
    await until(async () => (await app.screen()).some(row => row.includes("second line")));
    // The header box (tabs, details, bottom line); the composer box (top, two input rows, the counts inside it).
    const initial = await app.screen(), header = initial.slice(0, 3), footer = initial.slice(-4);
    expect(header[0]).toStartWith("│ probe ");
    expect(header[1]).toContain("ctx");
    expect(header[2]).toStartWith("└─");
    expect(footer[0]).toStartWith("┌");
    expect(initial.join("\n")).not.toContain("PRELAUNCH_SENTINEL");
    for (let i = 0; i < 30; i++) app.key("PPage");
    await until(async () => (await app.screen()).some(row => row.includes("PTY-ORIGINAL-HISTORY")));
    const scrolled = await app.screen();
    expect(scrolled.slice(0, 3)).toEqual(header);
    expect(scrolled.slice(-4)).toEqual(footer);
    for (let i = 0; i < 30; i++) app.key("NPage");
    await until(async () => (await app.screen()).some(row => row.includes("PTY-LATEST-HISTORY")));
    await app.quit();
    await until(async () => (await app.history()).includes("STTY_AFTER:"));
    const all = await app.history();
    expect(all).toContain("EXIT:0");
    expect(all.match(/STTY_AFTER:(\S+)/)?.[1]).toBe(all.match(/STTY_BEFORE:(\S+)/)?.[1]);
    expect(all).toContain("PRELAUNCH_SENTINEL_0");
    expect(all).toContain("PTY-ORIGINAL-HISTORY");
    expect(all).toContain("PTY-LATEST-HISTORY");
    expect(all).not.toContain("PTY-MODEL-ONLY");
  } finally {
    app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(!TMUX)("owned terminal: Option+Backspace deletes a word; Esc leaves insert mode keeping the draft", async () => {
  const dir = await home(async t => { await t.append({ type: "message", message: { role: "assistant", content: "PTY-SELECT-ME here" } }); });
  const app = await launch(dir);
  try {
    await until(async () => (await app.screen()).some(row => row.includes("PTY-SELECT-ME")));
    await app.insert();
    app.type("hello big world");
    await until(async () => input(await app.screen()) === "│ > hello big world");
    app.type("\x1b\x7f"); // two separate writes are covered in otui/terminal.test.ts; tmux calls are slower than the Alt window
    await until(async () => input(await app.screen()) === "│ > hello big");
    await Bun.sleep(100);
    app.type("\x1b");
    await until(async () => (await app.screen()).some(row => row.includes("[NORMAL]")));
    expect(input(await app.screen())).toBe("│ > hello big");
    await app.quit();
    await until(async () => (await app.history()).includes("EXIT:0"));
  } finally {
    app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
