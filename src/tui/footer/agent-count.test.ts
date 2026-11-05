import { expect, test } from "bun:test";
import { agentCounts, agentCountText } from "./agent-count";
import { appFixture } from "../../test/app-fixture";
import { App } from "../app";
import type { AgentInfo } from "../../protocol";

const { fakeTerm, fakeOrchestrators, until } = appFixture();
const mixed: AgentInfo[] = [{ name: "worker-live", live: true, status: "running", inventoryComplete: true },
  { name: "worker-old", live: false, status: "unknown", inventoryComplete: true }];
test("confirmed running agents remain visible alongside unverified history without inventing an exact total", () => {
  expect(agentCountText(agentCounts(mixed))).toBe("1 confirmed agent running (1 unverified)");
  expect(agentCounts(mixed).agentCount).toBeNull();
  expect(agentCountText(agentCounts([]))).toBe("0 agents running");
  expect(agentCountText(agentCounts([{ ...mixed[0]!, inventoryComplete: false }]))).toBe("1 confirmed agent running (inventory incomplete)");
  expect(agentCountText({ agentCount: null })).toBe("agent status unavailable");
});
test("TUI refresh shows confirmed counts, clears stale confirmations on failure, and recovers", async () => {
  let fail = false, rows = mixed;
  const fake = fakeOrchestrators(), app = new App({ term: fakeTerm(160), openOrchestrator: fake.openOrchestrator,
    agents: async () => { if (fail) throw new Error("inspection unavailable"); return rows; }, pollMs: 100_000 });
  const running = app.run("counts");
  try {
    await until(() => !!app.page && app.status(app.page).includes("1 confirmed agent running (1 unverified)"));
    fail = true; await app.refreshSessions();
    await until(() => app.status(app.page!).includes("agent status unavailable"));
    expect(app.page!.verifiedAgentCount).toBeUndefined();
    fail = false; rows = []; await app.refreshSessions();
    await until(() => app.status(app.page!).includes("0 agents running"));
    expect(Object.values(fake.said)).toEqual([[]]);
  } finally { app.quit(); await running; }
});
