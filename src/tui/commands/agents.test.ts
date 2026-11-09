import { describe, expect, test } from "bun:test";
import { recentAgent, RECENT_AGENT_MS } from "./agents";
import type { AgentInfo } from "../../protocol";

const NOW = Date.parse("2024-05-10T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 60 * 60 * 1000;
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
