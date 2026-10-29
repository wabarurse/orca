import { describe, expect, test } from "bun:test";
import { AGENTS_ALL_HINT, AGENTS_HINT, AgentsList, recentAgent, RECENT_AGENT_MS } from "./agents";
import type { AgentInfo } from "../../protocol";

const NOW = Date.parse("2024-05-10T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 60 * 60 * 1000;
/** Plain styling, so rows and footers read as text. */
const look = { row: (a: AgentInfo) => `${a.name} ${a.live ? "live" : "finished"}`, bold: (s: string) => `*${s}*`, dim: (s: string) => s };
const agents: AgentInfo[] = [
  { name: "worker-live", live: true, lastActiveAt: ago(48 * H) },
  { name: "worker-recent", live: false, lastActiveAt: ago(2 * H) },
  { name: "worker-task", live: false, lastActiveAt: ago(72 * H), openTask: true },
  { name: "worker-unknown", live: false },
  { name: "worker-old", live: false, lastActiveAt: ago(RECENT_AGENT_MS + 1) },
  { name: "reviewer-removed", live: false, lastActiveAt: ago(H), archived: true },
];

describe("recentAgent", () => {
  test("live, recent, open-task and unknown-time agents show; older finished ones and removed rows do not", () => {
    expect(agents.filter((a) => recentAgent(a, NOW)).map((a) => a.name)).toEqual(["worker-live", "worker-recent", "worker-task", "worker-unknown"]);
    expect(recentAgent({ name: "worker-edge", live: false, lastActiveAt: ago(RECENT_AGENT_MS - 1) }, NOW)).toBe(true);
    expect(recentAgent({ name: "worker-live", live: true, archived: true }, NOW)).toBe(true); // a live agent always shows
  });
});

describe("AgentsList", () => {
  test("the default view counts the hidden rows; a toggles all, marking removed rows", () => {
    const list = new AgentsList(agents, look);
    expect(list.view(NOW)).toEqual({
      items: ["worker-live live", "worker-recent finished", "worker-task finished", "worker-unknown finished"],
      footer: ["+2 older hidden", AGENTS_HINT],
    });
    expect(list.key("a", undefined)).toEqual({ handled: true });
    expect(list.view(NOW).items).toEqual([...agents.map(look.row).slice(0, 5), "reviewer-removed finished · removed"]);
    expect(list.view(NOW).footer).toEqual([AGENTS_ALL_HINT]);
    list.key("a", undefined);
    expect(list.shown(NOW).length).toBe(4);
  });

  test("an empty default view says so instead of a count of nothing", () => {
    const list = new AgentsList([{ name: "worker-old", live: false, lastActiveAt: ago(30 * H) }], look);
    expect(list.view(NOW)).toEqual({ items: [], footer: ["+1 older hidden", AGENTS_HINT] });
    expect(new AgentsList([], look).view(NOW).footer).toEqual(["no agents", AGENTS_HINT]);
  });

  test("d asks y/n for a finished agent and refuses a live or already removed one; only y or Y confirms", () => {
    const list = new AgentsList(agents, look);
    expect(list.key("d", agents[0])).toEqual({ handled: true });
    expect(list.confirm).toBeNull();
    expect(list.view(NOW).footer[0]).toContain("worker-live is live; stop it");
    expect(list.key("d", agents[5])).toEqual({ handled: true });
    expect(list.view(NOW).footer[0]).toBe("reviewer-removed is already removed");
    expect(list.key("d", agents[1])).toEqual({ handled: true });
    expect(list.view(NOW).footer[0]).toBe("*remove worker-recent from /agents? y/n*   transcripts stay");
    expect(list.key("Y", agents[1])).toEqual({ handled: true, remove: ["worker-recent"] });
    expect(list.confirm).toBeNull();
    list.key("d", agents[1]);
    expect(list.key(undefined, agents[1])).toEqual({ handled: true }); // any other key (an arrow, esc) cancels, and is used up
    expect(list.confirm).toBeNull();
    list.key("d", agents[1]);
    expect(list.key("n", agents[1])).toEqual({ handled: true });
    expect(list.key("d", undefined)).toEqual({ handled: true }); // nothing selected: nothing asked
    expect(list.confirm).toBeNull();
  });

  test("D asks to remove every finished, not yet removed agent, hidden ones included", () => {
    const list = new AgentsList(agents, look);
    list.key("D", agents[0]);
    expect(list.view(NOW).footer[0]).toBe("*remove 4 finished agents from /agents? y/n*   transcripts stay");
    expect(list.key("y", agents[0])).toEqual({ handled: true, remove: ["worker-recent", "worker-task", "worker-unknown", "worker-old"] });
    const none = new AgentsList([agents[0]!, agents[5]!], look);
    none.key("D", agents[0]);
    expect(none.confirm).toBeNull();
    expect(none.view(NOW).footer[0]).toBe("no finished agents to remove");
  });

  test("other keys are left to the menu; the outcome of a removal is the status", () => {
    const list = new AgentsList(agents, look);
    for (const text of [undefined, "j", "k", "q", "x"]) expect(list.key(text, agents[1])).toEqual({ handled: false });
    list.removed({ archived: ["worker-recent", "worker-old"], live: ["worker-task"] });
    expect(list.view(NOW).footer[0]).toBe("removed 2 agents from /agents; kept worker-task (live); transcripts stay");
    list.key("a", undefined);
    expect(list.status).toBe("");
  });
});
