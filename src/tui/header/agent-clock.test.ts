import { describe, expect, test } from "bun:test";
import { agentRow, elapsedMs, formatElapsed, reselect } from "./agent-clock";

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
const plain = (s: string) => Bun.stripANSI(s);

describe("formatElapsed", () => {
  test("seconds under a minute, minutes and seconds under an hour, hours and minutes under a day, then days and hours", () => {
    const cases: [number, string][] = [
      [0, "0s"], [999, "0s"], [S, "1s"], [59 * S, "59s"], [60 * S, "1m 00s"], [3 * M + 12 * S, "3m 12s"],
      [59 * M + 59 * S, "59m 59s"], [H, "1h 00m"], [H + 4 * M, "1h 04m"], [23 * H + 59 * M + 59 * S, "23h 59m"],
      [D, "1d 0h"], [2 * D + 3 * H + 59 * M, "2d 3h"], [100 * D, "100d 0h"],
    ];
    for (const [ms, text] of cases) expect(formatElapsed(ms)).toBe(text);
  });

  test("a negative or invalid span reads 0s", () => {
    expect(formatElapsed(-5000)).toBe("0s");
    expect(formatElapsed(NaN)).toBe("0s");
  });
});

describe("agentRow", () => {
  const start = "2024-05-01T10:00:00.000Z";
  const at = (ms: number) => Date.parse(start) + ms;

  test("a live agent ticks from its start; the clock is bold, the status dim", () => {
    const row = agentRow({ name: "worker-foo", live: true, startedAt: start }, at(3 * M + 12 * S));
    expect(plain(row).trimEnd()).toBe("worker-foo  live 3m 12s");
    expect(row).toContain("\x1b[1m3m 12s");
    expect(row).toContain("\x1b[2mlive");
  });

  test("a finished agent shows its final time, dim, and ~ when the end is approximate", () => {
    const base = { name: "worker-foo", live: false, startedAt: start, endedAt: "2024-05-01T10:14:02.000Z" };
    const row = agentRow(base, at(99 * H));
    expect(plain(row).trimEnd()).toBe("worker-foo  finished 14m 02s");
    expect(row).not.toContain("\x1b[1m");
    expect(plain(agentRow({ ...base, approximateEnd: true }, 0)).trimEnd()).toBe("worker-foo  finished ~14m 02s");
  });

  test("a row keeps its width as the clock ticks", () => {
    const a = { name: "w", live: true, startedAt: start };
    const widths = new Set([0, 59 * S, 60 * S, 59 * M + 59 * S, H, 23 * H, 2 * D + 3 * H].map((ms) => plain(agentRow(a, at(ms))).length));
    expect(widths.size).toBe(1);
    const f = { name: "w", live: false, startedAt: start };
    expect(new Set([S, 3 * M, 2 * D].map((ms) => plain(agentRow({ ...f, endedAt: new Date(at(ms)).toISOString() }, 0)).length)).size).toBe(1);
  });

  test("with no usable times the row is just live or finished", () => {
    expect(plain(agentRow({ name: "a", live: true }, 0))).toBe("a  live");
    expect(plain(agentRow({ name: "a", live: false }, 0))).toBe("a  finished");
    expect(plain(agentRow({ name: "a", live: false, startedAt: start }, 0))).toBe("a  finished");
    expect(plain(agentRow({ name: "a", live: true, startedAt: "nonsense" }, 0))).toBe("a  live");
    expect(elapsedMs({ live: false, startedAt: start, endedAt: "nonsense" }, 0)).toBeNull();
  });
});

describe("reselect", () => {
  const names = (...n: string[]) => n.map((name) => ({ name }));
  test("follows the selected agent by name through reordering and insertions", () => {
    expect(reselect(1, names("a", "b", "c"), names("c", "b", "a"))).toBe(1);
    expect(reselect(2, names("a", "b", "c"), names("x", "a", "b", "c"))).toBe(3);
  });
  test("when the agent is gone it keeps the position, within range", () => {
    expect(reselect(2, names("a", "b", "c"), names("a", "b"))).toBe(1);
    expect(reselect(0, names("a"), names("b", "c"))).toBe(0);
  });
});
