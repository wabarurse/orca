import { expect, test } from "bun:test";
import { runningAgentCount } from "./agent-count";
import { appFixture } from "../../test/app-fixture";
import { App } from "../app";
import type { AgentInfo } from "../../protocol";

const { fakeTerm, fakeOrchestrators, until } = appFixture();
const mixed: AgentInfo[] = [{ name: "worker-live", live: true, status: "running", inventoryComplete: true },
  { name: "worker-old", live: false, status: "unknown", inventoryComplete: true }];
test("counts distinct verified running workers and reviewers only", () => {
  expect(runningAgentCount([...mixed, mixed[0]!, { name: "orchestrator", live: true }])).toBe(1);
  expect(runningAgentCount([])).toBe(0);
});
test("TUI refresh shows confirmed counts, clears stale confirmations on failure, and recovers", async () => {
  let fail = false, rows = mixed;
  const fake = fakeOrchestrators(), app = new App({ term: fakeTerm(160), openOrchestrator: fake.openOrchestrator,
    agents: async () => { if (fail) throw new Error("inspection unavailable"); return rows; }, pollMs: 100_000 });
  const running = app.run("counts");
  try {
    await until(() => !!app.page && app.status(app.page).includes("1 agents |"));
    fail = true; await app.refreshSessions();
    await until(() => app.status(app.page!).includes("? agents |"));
    expect(app.page!.agentCount).toBeUndefined();
    fail = false; rows = []; await app.refreshSessions();
    await until(() => app.status(app.page!).includes("0 agents |"));
    expect(Object.values(fake.said)).toEqual([[]]);
  } finally { app.quit(); await running; }
});
