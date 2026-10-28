import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "../../config/config";
import { rolePrompt, DYNAMIC_DISPATCH } from "./shared";
import { definition } from "../definitions/files";
import { ask } from "../tools/ask";
const home = mkdtempSync(join(tmpdir(), "orca-adaptive-prompts-"));
const previous = process.env.ORCA_HOME; process.env.ORCA_HOME = home;
afterAll(() => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; rmSync(home, { recursive: true, force: true }); });

describe("adaptive role contracts", () => {
  test("one loop preserves delegation preference without mandatory publication", () => {
    const p = rolePrompt("orchestrator", defaults);
    expect(p).toContain("Delegate substantial");
    expect(p).toContain("without taskId");
    expect(p).toContain("do not impose");
    expect(p).toContain("never auto-merge");
    expect(p).toContain("fresh=true");
    expect(p).not.toContain("spawn a worker → it reports → spawn");
  });
  test("worker reports are concise and preserve evidence and uncertainty", () => {
    const p = rolePrompt("worker", defaults);
    expect(p).toContain("Delegation does not require a commit");
    expect(p).toContain("evidence artifacts");
    expect(p).toContain("uncertainty");
    expect(p).toContain("later user corrections");
    expect(p).not.toContain("no length limit");
  });
  test("review remains read only and threshold settings remain effective", () => {
    const p = rolePrompt("reviewer", { ...defaults, cyclomatic: 7, cognitive: 9 });
    expect(p).toContain("Never edit code");
    expect(p).toContain("cyclomatic > 7, cognitive > 9");
    expect(p).toContain("never grants merge permission");
    expect(p).not.toContain("no length limit");
  });
  test("dispatch and zero review rounds do not force one-off work into CI", () => {
    for (const rounds of [0, 1, 100]) {
      const p = rolePrompt("orchestrator", { ...defaults, dynamicDispatch: true, maxReviewRounds: rounds });
      expect(p).toContain(DYNAMIC_DISPATCH);
      expect(p).toContain("does not require ordinary work");
      expect(p).toContain("Honor explicit workflow");
    }
  });
  test("role prompts stay bounded and retain terminology", () => {
    for (const role of ["orchestrator", "worker", "reviewer"] as const) {
      const p = rolePrompt(role, defaults);
      expect(p.length).toBeLessThan(4000);
      expect(p).toContain("Use the user’s terminology");
      expect(p).not.toMatch(/\{\w+\}/);
    }
  });
  test("user-edited definitions remain present with shipped contracts", () => {
    definition("prompts/orchestrator.md", "old baseline");
    writeFileSync(join(home, "prompts", "orchestrator.md"), "Project rule: review database migrations.");
    const p = rolePrompt("orchestrator", defaults);
    expect(p).toContain("review database migrations");
    expect(p).toContain("Honor explicit workflow");
  });
  test("questions retain authorization and silence rules", () => {
    expect(ask.spec.description).toContain("currently unresolved decision");
    expect(ask.spec.description).toContain("Skip, silence and closing the panel never apply it");
    expect(ask.spec.description).toContain("new access, credentials, provider or billing");
  });
});
