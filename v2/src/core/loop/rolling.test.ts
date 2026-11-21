import { expect, test } from "bun:test";
import { paths } from "../../config";
import { fakeProvider, text } from "../../test/fake-provider";
import { tempHome } from "../../test/home";
import { searchArchive } from "../archive";
import { createConversation } from "../conversations";
import { openTranscript } from "../transcript";
import type { Window } from "./budget";
import { RollingCompactor, rollingCut } from "./rolling";

const home = tempHome("rolling");

test("background memory publishes a summary with plugin sections and keeps the newest exchange verbatim", async () => {
  const c = await createConversation(home.path(), "r");
  const transcript = openTranscript(paths.transcript(c.id, "orchestrator"));
  await transcript.append({ type: "message", inbox: [], message: { role: "user", content: "GOAL: migrate the billing service to Postgres; decision: keep the old API" } });
  for (let i = 0; i < 30; i++) {
    await transcript.append({ type: "message", inbox: [], message: { role: "assistant", content: `step ${i} ${"x".repeat(3000)}` } });
    await transcript.append({ type: "message", inbox: [], message: { role: "user", content: `next ${i} ${"y".repeat(3000)}` } });
  }
  await transcript.append({ type: "message", inbox: [], message: { role: "assistant", content: "latest answer: the cutover is planned for Friday" } });
  await transcript.append({ type: "message", inbox: [], message: { role: "user", content: "LATEST: also keep the audit log" } });
  const memory = JSON.stringify({ summary: ["User goal: migrate billing to Postgres.", "Decision: keep the old API."], pending: ["Plan the cutover."] });
  const provider = fakeProvider([[text(memory)]]);
  const rolling = new RollingCompactor(c.id, transcript, { small: false, triggerTokens: 5000, tailTokens: 2000, sections: [{ title: "Pins", text: async () => "- p1: ship on friday" }] });
  const window: Window = { model: "claude-sonnet-5-5", system: "", tools: [], contextLimit: 200_000, measured: null };
  const notices: string[] = [];
  await rolling.boundary({ window, provider, signal: new AbortController().signal, notice: t => { notices.push(t); } }, true);
  const summary = transcript.branch()[0];
  expect(summary?.type).toBe("summary");
  if (summary?.type !== "summary") return;
  expect(summary.text).toContain("Pins (kept as saved; authoritative)\n- p1: ship on friday");
  expect(summary.text).toContain("Decision: keep the old API.");
  expect(JSON.stringify(summary.retained)).toContain("LATEST: also keep the audit log");
  expect(JSON.stringify(summary.retained)).not.toContain("GOAL: migrate");
  expect(notices.at(-1)).toContain("compaction complete");
  expect(searchArchive([c.id], ["billing Postgres"], 5).map(hit => hit.role)).toContain("user");
});

test("the cut always keeps the newest exchange, however large", () => {
  const big = "z".repeat(50_000);
  expect(rollingCut([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: big }], 10)).toBe(2);
});
