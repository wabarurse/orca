import { describe, expect, test } from "bun:test";
import { Alerts, gistOf } from "./alerts";

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
