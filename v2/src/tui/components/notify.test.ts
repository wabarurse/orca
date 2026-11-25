import { describe, expect, test } from "bun:test";
import { autoChannel, isChannelSetting, notification, notifyChannel, passthrough, plainLine, programStatus, progress, reportsProgress } from "./notify";

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
