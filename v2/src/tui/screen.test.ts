import { describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { AgentEvent, OpenSpan } from "../core/types";
import { Alerts, gistOf } from "./alerts";
import { contextLine } from "./app";
import type { screens } from "./components";
import { linkAt, linkSpanAt, underlineSpan } from "./components/links";
import { autoChannel, isChannelSetting, notification, notifyChannel, passthrough, plainLine, programStatus, progress, reportsProgress } from "./components/notify";
import { swimming, WAVE_MS } from "./components/shimmer";
import { wordWrap } from "./components/text";
import { Display } from "./otui/display";
import { CORE_FOLDS, items, type Piece, tail, USER_ROWS, userItem } from "./view";

describe("the conversation view", () => {
  const NOW = Date.parse("2026-01-01T00:10:00.000Z");
  const at = (secondsAgo: number): string => new Date(NOW - secondsAgo * 1000).toISOString();
  const open = (id: string, kind: OpenSpan["kind"], label: string, secondsAgo: number): OpenSpan => ({ id, kind, label, agent: "orchestrator", startedAt: at(secondsAgo) });
  const plain = (rows: string[]): string => Bun.stripANSI(rows.join("\n"));

  test("the activity line names the current phase and its elapsed time", () => {
    const model: AgentEvent[] = [{ kind: "span_start", span: open("m", "model", "claude-opus-5-5", 8) }];
    expect(plain(tail(model, "", 80, NOW, true, null))).toContain(" swimming (8s)");

    const call = { id: "t1", name: "bash", input: { command: "bun test src/core" } };
    const tool: AgentEvent[] = [{ kind: "tool_start", call }, { kind: "span_start", span: open("t1", "tool", "bash: bun test src/core", 34) }];
    const shown = plain(tail(tool, "", 80, NOW, true, null));
    expect(shown).toContain("bun test src/core) (34s)");
    expect(shown).not.toContain("swimming");

    const ended: AgentEvent[] = [...model, { kind: "span_end", span: { ...open("m", "model", "claude-opus-5-5", 8), endedAt: at(0), durationMs: 8000, detail: {} } }];
    expect(plain(tail(ended, "", 80, NOW, true, null))).toContain(" swimming");
  });

  test("between turns the orchestrator shows what it waits for, but not an idle wait for input", () => {
    expect(plain(tail([], "", 80, NOW, false, open("w", "wait-worker", "worker-fix-x", 72)))).toBe("waiting for worker-fix-x (1m12s)");
    expect(tail([], "", 80, NOW, false, open("i", "wait-inbox", "input", 72))).toEqual([]);
  });

  test("tool calls, agent messages and spawned agents fold the way the sketch shows", () => {
    const call = (id: string, name: string, input: Record<string, unknown>, text: string): Piece => ({ kind: "call", call: { call: { id, name, input }, outcome: { id, ok: true, text } } });
    const list: Piece[] = [
      call("a", "bash", { command: "ls" }, "x"), call("b", "read", { path: "a.ts" }, "y"),
      { kind: "text", text: "between" },
      call("c", "subagent", { action: "spawn", branch: "fix-a" }, "worker-fix-a started (bundle worker, log l)"),
      call("d", "subagent", { action: "spawn", branch: "fix-b" }, "worker-fix-b got the brief as a message (bundle worker, log l)"),
      { kind: "from", from: "worker-fix-a", text: "done" },
    ];
    const out = items(list, { cols: 80, open: new Set<string>(), folds: new Map(CORE_FOLDS) });
    const titles = out.flatMap(item => item.kind === "fold" ? [Bun.stripANSI(item.title)] : []);
    expect(titles).toEqual(["⚒ 2 tool calls · bash ×1, read ×1", "⚒ 2 tool calls · subagent ×2", "+ 2 agents", "✉ from agent worker-fix-a"]);
    const agents = out.find(item => item.kind === "fold" && item.title === "+ 2 agents");
    expect(agents?.kind === "fold" ? [agents.opens, agents.rows.map(r => Bun.stripANSI(r))] : null).toEqual(["agents", ["● worker-fix-a  open", "● worker-fix-b  open"]]);
  });

  test("one step's calls collapse together, whatever the tools, and a single call folds too", () => {
    const call = (id: string, name: string, input: Record<string, unknown>, text: string): Piece => ({ kind: "call", call: { call: { id, name, input }, outcome: { id, ok: true, text } } });
    const titles = (list: Piece[]): string[] => items(list, { cols: 80, open: new Set<string>(), folds: new Map(CORE_FOLDS) }).flatMap(item => item.kind === "fold" ? [Bun.stripANSI(item.title)] : []);
    expect(titles([call("a", "bash", { command: "ls" }, "x"), call("b", "subagent", { action: "spawn", branch: "fix" }, "worker-fix started (bundle worker, log l)")]))
      .toEqual(["⚒ 2 tool calls · bash ×1, subagent ×1", "+ 1 agent"]);
    expect(titles([call("a", "memory", { action: "write" }, "wrote")])).toEqual(["⚒ 1 tool call · memory ×1"]);
  });

  test("a long user message shows its first lines and how many more, all of them once opened", () => {
    const text = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n");
    const shut = userItem(text, "p-0", { cols: 80, open: new Set() });
    expect(shut.kind === "user" ? [shut.rows.length, shut.more, shut.open] : null).toEqual([USER_ROWS, 15, false]);
    const opened = userItem(text, "p-0", { cols: 80, open: new Set(["p-0"]) });
    expect(opened.kind === "user" ? [opened.rows.length, opened.more, opened.open] : null).toEqual([25, 15, true]);
    const short = userItem("hello", "p-1", { cols: 80, open: new Set(["p-1"]) });
    expect(short.kind === "user" ? [short.rows, short.more, short.open] : null).toEqual([["hello"], 0, false]);
  });
});

describe("drawing the chat", () => {
  const chat = (rows: string[]): screens.ChatScreen => ({ kind: "chat", header: null, items: [{ kind: "rows", key: "r", gap: false, rows }], tail: [], welcome: [], footer: ["› "], cursor: null });

  test("hovering a link underlines it, clicking it asks to open it, and a finished drag selection asks to copy", async () => {
    const setup = await createTestRenderer({ width: 60, height: 10 });
    const actions: screens.ScreenAction[] = [];
    const display = new Display(setup.renderer, action => { actions.push(action); }, () => {});
    display.show(chat(["read https://example.com/docs first", "plain words here"]));
    await setup.renderOnce();
    const frame = setup.captureCharFrame().split("\n");
    const y = frame.findIndex(line => line.includes("https://example.com"));
    const x = (frame[y] ?? "").indexOf("example");
    expect(y).toBeGreaterThanOrEqual(0);
    const underlined = (): string => setup.captureSpans().lines.flatMap(l => l.spans).filter(s => (s.attributes & TextAttributes.UNDERLINE) !== 0).map(s => s.text).join("");
    expect(underlined()).toBe("");

    await setup.mockMouse.moveTo(x, y);
    await setup.renderOnce();
    expect(underlined()).toBe("https://example.com/docs");
    await setup.mockMouse.moveTo(2, y + 1);
    await setup.renderOnce();
    expect(underlined()).toBe("");

    await setup.mockMouse.click(x, y);
    expect(actions).toContainEqual({ kind: "link", url: "https://example.com/docs" });

    const words = y + 1, from = (frame[words] ?? "").indexOf("plain");
    await setup.mockMouse.drag(from, words, from + 4, words);
    await setup.renderOnce();
    expect(actions.filter(a => a.kind === "copy")).toEqual([{ kind: "copy", text: "plain" }]);
    await setup.dispose();
  });

  test("at the bottom new content keeps the view at the bottom; scrolled up, new content and streaming leave it in place", async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 });
    const display = new Display(setup.renderer, () => {}, () => {});
    const rows = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    display.show(chat(rows));
    await setup.renderOnce();
    display.show(chat([...rows, "line 30"]));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("line 30");

    display.scroll("page-up");
    display.scroll("page-up");
    await setup.renderOnce();
    const before = setup.captureCharFrame();
    display.show(chat([...rows, "line 30", "line 31"]));
    await setup.renderOnce();
    display.show({ ...chat([...rows, "line 30", "line 31"]), tail: ["streaming"] });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toBe(before);
    await setup.dispose();
  });

  test("a capped user message has a row that asks to open it", async () => {
    const setup = await createTestRenderer({ width: 60, height: 30 });
    const actions: screens.ScreenAction[] = [];
    const display = new Display(setup.renderer, action => { actions.push(action); }, () => {});
    const user: screens.ScreenItem = { kind: "user", key: "p-0", gap: false, rows: ["first", "second"], fill: null, open: false, more: 7 };
    display.show({ ...chat([]), items: [user] });
    await setup.renderOnce();
    const frame = setup.captureCharFrame().split("\n");
    const y = frame.findIndex(line => line.includes("7 more lines"));
    expect(y).toBeGreaterThanOrEqual(0);
    await setup.mockMouse.click((frame[y] ?? "").indexOf("7 more"), y);
    expect(actions).toContainEqual({ kind: "toggle", key: "p-0" });
    display.show({ ...chat([]), items: [{ ...user, open: true }] });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("show less");
    await setup.dispose();
  });
});

describe("the header", () => {
  const cases: [number | null, string, string][] = [
    [45_300, "claude-opus-5-5", " · ctx 45k/1M"],
    [512, "gpt-6-astra", " · ctx 512/272k"],
    [1_250_000, "claude-opus-5-5", " · ctx 1.3M/1M"],
    [null, "claude-opus-5-5", " · ctx -/1M"],
    [9_000, "some-unknown-model", " · ctx 9k/~128k"],
  ];

  test.each(cases)("the header's third row shows how much of the model's context the conversation uses: %p tokens of %s", (used, model, shown) => {
    expect(contextLine(used, model)).toBe(shown);
  });
});

describe("wrapping text", () => {
  test("a lone escape that starts no sequence is wrapped as text, not looped on", () => {
    expect(wordWrap("a \x1b b", 80)).toEqual(["a \x1b b"]);
    expect(wordWrap("\x1bx", 80)).toEqual(["\x1bx"]);
    expect(wordWrap("one two\x1b three", 7).length).toBeGreaterThan(1);
  });
});

describe("links", () => {
  const osc8 = (url: string, text: string): string => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

  test("a link's span is found for written-out addresses and OSC 8 links, and only openable ones count", () => {
    const bare = "see https://example.com/docs. then";
    expect(linkSpanAt(bare, 6)).toEqual({ url: "https://example.com/docs", start: 4, end: 28 });
    expect(linkSpanAt(bare, 2)).toBeUndefined();
    const named = `PR ${osc8("https://github.com/o/r/pull/7", "#7")} open`;
    expect(linkSpanAt(named, 3)).toEqual({ url: "https://github.com/o/r/pull/7", start: 3, end: 5 });
    expect(linkAt(named, 6)).toBeUndefined();
    expect(linkAt(osc8("javascript:alert(1)", "click"), 1)).toBeUndefined();
  });

  test("underlining a span wraps exactly its cells, and keeps it underlined across colour changes inside it", () => {
    const row = "go \x1b[36mhttps://a.io\x1b[0m now";
    const span = linkSpanAt(row, 5);
    expect(span).toEqual({ url: "https://a.io", start: 3, end: 15 });
    if (span === undefined) return;
    const out = underlineSpan(row, span);
    expect(Bun.stripANSI(out)).toBe(Bun.stripANSI(row));
    expect(out).toBe("go \x1b[36m\x1b[4mhttps://a.io\x1b[0m\x1b[4m\x1b[24m now");
  });
});

describe("the swimming animation", () => {

  test("without colour it is plain text, and the waves still move", () => {
    expect(swimming("8s", 0, { NO_COLOR: "1" })).toBe("~∽^ swimming (8s)");
    expect(swimming(null, WAVE_MS, { NO_COLOR: "1" })).toBe("∽^∽ swimming");
    expect(Bun.stripANSI(swimming("8s", 0, { COLORTERM: "truecolor" }))).toBe("~∽^ swimming (8s)");
  });
});

describe("terminal notifications", () => {
  const decode = (field: string, sequence: string): string => {
    const match = new RegExp(`${field}=([A-Za-z0-9+/=]+)`).exec(sequence);
    return match === null ? "" : Buffer.from(match[1] ?? "", "base64").toString();
  };

  describe("notification channel, as Claude Code's auto picks it", () => {
    test("Rex, iTerm2, kitty, Ghostty and WezTerm by their environment; anything else rings the bell", () => {
      expect(autoChannel({ REX_SESSION: "session:1", TERM_PROGRAM: "rex" })).toBe("ghostty");
      expect(autoChannel({ TERM_PROGRAM: "tmux", REX_SESSION: "session:1", TMUX: "/tmp/x" })).toBe("ghostty");
      expect(autoChannel({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
      expect(autoChannel({ TERM_PROGRAM: "tmux", LC_TERMINAL: "iTerm2" })).toBe("iterm2");
      expect(autoChannel({ TERM: "xterm-kitty" })).toBe("kitty");
      expect(autoChannel({ KITTY_WINDOW_ID: "3" })).toBe("kitty");
      expect(autoChannel({ TERM_PROGRAM: "ghostty" })).toBe("ghostty");
      expect(autoChannel({ TERM: "xterm-ghostty" })).toBe("ghostty");
      expect(autoChannel({ TERM_PROGRAM: "WezTerm" })).toBe("iterm2");
      expect(autoChannel({ TERM_PROGRAM: "Apple_Terminal" })).toBe("terminal_bell");
      expect(autoChannel({})).toBe("terminal_bell");
    });

    test("a set channel wins over auto; unknown names are not settings", () => {
      expect(notifyChannel("kitty", { TERM_PROGRAM: "iTerm.app" })).toBe("kitty");
      expect(notifyChannel("auto", { TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
      expect(isChannelSetting("iterm2_with_bell")).toBe(true);
      expect(isChannelSetting("growl")).toBe(false);
    });
  });

  describe("notification sequences", () => {
    test("OSC 9 carries 'title: body', OSC 777 notify;title;body, OSC 99 title, body and focus, BEL alone", () => {
      expect(notification("iterm2", "orca2", "chat: done", 1)).toEqual(["\x1b]9;orca2: chat: done\x07"]);
      expect(notification("iterm2_with_bell", "orca2", "chat: done", 1)).toEqual(["\x1b]9;orca2: chat: done\x07", "\x07"]);
      expect(notification("ghostty", "orca2", "chat: done", 1)).toEqual(["\x1b]777;notify;orca2;chat: done\x07"]);
      expect(notification("kitty", "orca2", "chat: done", 42)).toEqual([
        "\x1b]99;i=42:d=0:p=title;orca2\x1b\\",
        "\x1b]99;i=42:p=body;chat: done\x1b\\",
        "\x1b]99;i=42:d=1:a=focus;\x1b\\",
      ]);
      expect(notification("terminal_bell", "orca2", "chat: done", 1)).toEqual(["\x07"]);
      expect(notification("notifications_disabled", "orca2", "chat: done", 1)).toEqual([]);
    });

    test("the body is one plain line: escapes and control characters go, it is shortened, a title loses its semicolons", () => {
      const [sequence] = notification("ghostty", "or;ca", "line one\n\x1b[31mred\x1b[0m\x07 and \x1b]0;evil\x07", 1);
      expect(sequence).toBe("\x1b]777;notify;or,ca;line one red and ]0;evil\x07");
      expect(plainLine("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
      expect(plainLine("  a \t b  ", 10)).toBe("a b");
    });

    test("inside tmux every sequence is wrapped for passthrough with its escapes doubled", () => {
      expect(passthrough("\x1b]9;hi\x07", { TMUX: "/tmp/tmux-1/default,1,0" })).toBe("\x1bPtmux;\x1b\x1b]9;hi\x07\x1b\\");
      expect(passthrough("\x1b]9;hi\x07", {})).toBe("\x1b]9;hi\x07");
    });
  });

  describe("OSC 7501 program status and OSC 9;4 progress", () => {
    test("state and app first, then kind, progress and base64 title and msg, as Claude Code writes them", () => {
      const working = programStatus({ state: "working", title: "orca2 · chat", msg: "working · chat", progress: null });
      expect(working.startsWith("\x1b]7501;state=working:app=orca2:title=")).toBe(true);
      expect(working.endsWith("\x07")).toBe(true);
      expect(decode("title", working)).toBe("orca2 · chat");
      expect(decode("msg", working)).toBe("working · chat");
      const blocked = programStatus({ state: "blocked", kind: "question", progress: 140.4, title: null, msg: "1 question waiting" });
      expect(blocked.startsWith("\x1b]7501;state=blocked:app=orca2:kind=question:progress=100:msg=")).toBe(true);
      expect(programStatus({ state: "idle", title: null, msg: null })).toBe("\x1b]7501;state=idle:app=orca2\x07");
      expect(programStatus({ state: "done", title: null, msg: "" })).toBe("\x1b]7501;state=done:app=orca2\x07");
      expect(programStatus({ state: "clear" })).toBe("\x1b]7501;state=clear\x07");
    });

    test("title is cut to 192 bytes before encoding", () => {
      const long = programStatus({ state: "idle", title: "é".repeat(200), msg: null });
      expect(new TextEncoder().encode(decode("title", long)).length).toBeLessThanOrEqual(192);
    });

    test("progress is indeterminate while busy and cleared after; only terminals known to show it get it", () => {
      expect(progress(true)).toBe("\x1b]9;4;3;\x07");
      expect(progress(false)).toBe("\x1b]9;4;0;\x07");
      expect(reportsProgress({ REX_SESSION: "session:1" })).toBe(true);
      expect(reportsProgress({ TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.2.0" })).toBe(true);
      expect(reportsProgress({ TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.1.3" })).toBe(false);
      expect(reportsProgress({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.6" })).toBe(true);
      expect(reportsProgress({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.0" })).toBe(false);
      expect(reportsProgress({ TERM_PROGRAM: "iTerm.app" })).toBe(false);
      expect(reportsProgress({ WT_SESSION: "x", REX_SESSION: "session:1" })).toBe(false);
      expect(reportsProgress({ TERM_PROGRAM: "Apple_Terminal", TERM_PROGRAM_VERSION: "455" })).toBe(false);
    });
  });
});

describe("alerts", () => {
  function harness(env: Record<string, string>, answers = false): { alerts: Alerts; sent: string[] } {
    const sent: string[] = [];
    const alerts = new Alerts({ signal: sequence => { sent.push(sequence); return true; }, answersStatus: () => answers }, env, () => 7);
    return { alerts, sent };
  }

  const chat = { id: "c-1", name: "fix login" };
  const notices = (sent: string[]): string[] => sent.filter(s => s.startsWith("\x1b]777;"));
  const statuses = (sent: string[]): string[] => sent.filter(s => s.startsWith("\x1b]7501;"));

  describe("Alerts", () => {
    test("a finished turn notifies once with the chat name and the reply's gist; the first sighting is silent", () => {
      const { alerts, sent } = harness({ REX_SESSION: "session:1" });
      alerts.turn({ ...chat, busy: false, error: null, gist: "" });
      alerts.turn({ ...chat, busy: true, error: null, gist: "" });
      alerts.turn({ ...chat, busy: true, error: null, gist: "" });
      alerts.turn({ ...chat, busy: false, error: null, gist: "PR opened" });
      alerts.turn({ ...chat, busy: false, error: null, gist: "PR opened" });
      expect(notices(sent)).toEqual(["\x1b]777;notify;orca2;fix login: PR opened\x07"]);
    });

    test("a failed turn says so", () => {
      const { alerts, sent } = harness({ TERM_PROGRAM: "iTerm.app" });
      alerts.turn({ ...chat, busy: true, error: null, gist: "" });
      alerts.turn({ ...chat, busy: false, error: "rate limited", gist: "" });
      expect(sent).toContain("\x1b]9;orca2: fix login: turn failed: rate limited\x07");
    });

    test("questions notify when their count rises, plugin notices once each, neither on the first read", () => {
      const { alerts, sent } = harness({ REX_SESSION: "session:1" });
      alerts.questions(chat, 0);
      alerts.questions(chat, 2);
      alerts.questions(chat, 1);
      alerts.notices(chat, [{ id: "m1", from: "pr-watch", text: "old" }]);
      alerts.notices(chat, [{ id: "m1", from: "pr-watch", text: "old" }, { id: "m2", from: "pr-watch", text: "PR #3 merged" }]);
      expect(notices(sent)).toEqual([
        "\x1b]777;notify;orca2;fix login: 2 questions waiting for you\x07",
        "\x1b]777;notify;orca2;fix login: pr-watch: PR #3 merged\x07",
      ]);
    });

    test("status: working with progress while a turn runs, blocked on a question first, done after, cleared on leave", () => {
      const { alerts, sent } = harness({ REX_SESSION: "session:1" });
      alerts.focus(chat);
      expect(alerts.status().state).toBe("idle");
      alerts.turn({ ...chat, busy: true, error: null, gist: "" });
      expect(alerts.status().state).toBe("working");
      expect(sent).toContain("\x1b]9;4;3;\x07");
      alerts.questions(chat, 1);
      expect(alerts.status()).toMatchObject({ state: "blocked", kind: "question" });
      alerts.questions(chat, 0);
      alerts.turn({ ...chat, busy: false, error: null, gist: "all green" });
      expect(alerts.status()).toMatchObject({ state: "done", msg: "all green" });
      expect(sent).toContain("\x1b]9;4;0;\x07");
      const before = statuses(sent).length;
      alerts.turn({ ...chat, busy: false, error: null, gist: "all green" });
      expect(statuses(sent).length).toBe(before);
      alerts.leave();
      expect(sent.at(-1)).toBe("\x1b]7501;state=clear\x07");
    });

    test("outside Rex status is sent only when the terminal answered the OSC 7501 query; tmux wraps everything", () => {
      const plain = harness({ TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.0.0" });
      plain.alerts.turn({ ...chat, busy: true, error: null, gist: "" });
      expect(statuses(plain.sent)).toEqual([]);
      const probed = harness({ TERM_PROGRAM: "ghostty" }, true);
      probed.alerts.turn({ ...chat, busy: true, error: null, gist: "" });
      expect(statuses(probed.sent).length).toBe(1);
      const tmux = harness({ REX_SESSION: "session:1", TMUX: "/tmp/t,1,0" });
      tmux.alerts.turn({ ...chat, busy: true, error: null, gist: "" });
      expect(tmux.sent.every(s => s.startsWith("\x1bPtmux;"))).toBe(true);
    });

    test("turned off it sends nothing and clears what it showed; a bad channel falls back to auto", () => {
      const { alerts, sent } = harness({ REX_SESSION: "session:1" });
      alerts.turn({ ...chat, busy: true, error: null, gist: "" });
      alerts.configure(false, "auto");
      expect(sent.slice(-2)).toEqual(["\x1b]7501;state=clear\x07", "\x1b]9;4;0;\x07"]);
      const count = sent.length;
      alerts.turn({ ...chat, busy: false, error: null, gist: "x" });
      expect(sent.length).toBe(count);
      alerts.configure(true, "nonsense");
      alerts.turn({ ...chat, busy: true, error: null, gist: "" });
      alerts.turn({ ...chat, busy: false, error: null, gist: "y" });
      expect(sent).toContain("\x1b]777;notify;orca2;fix login: y\x07");
    });

    test("the gist is the reply's first paragraph without markdown marks", () => {
      expect(gistOf("**Done.** PR #3 is open.\n\nDetails follow")).toBe("Done. PR #3 is open.");
    });
  });
});
