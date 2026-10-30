import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "../../config/config";
import { rolePrompt } from "./shared";
import { definition } from "../definitions/files";
import { ask } from "../tools/ask";
const home = mkdtempSync(join(tmpdir(), "orca-adaptive-prompts-"));
const previous = process.env.ORCA_HOME; process.env.ORCA_HOME = home;
afterAll(() => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; rmSync(home, { recursive: true, force: true }); });

describe("adaptive role contracts", () => {
  test("one loop preserves delegation preference without mandatory publication", () => {
    const p = rolePrompt("orchestrator");
    expect(p).toContain("Delegate substantial");
    expect(p).toContain("without taskId");
    expect(p).toContain("do not impose");
    expect(p).toContain("never auto-merge");
    expect(p).toContain("fresh=true");
    expect(p).not.toContain("spawn a worker → it reports → spawn");
  });
  test("worker reports are concise and preserve evidence and uncertainty", () => {
    const p = rolePrompt("worker");
    expect(p).toContain("Delegation does not require a commit");
    expect(p).toContain("evidence artifacts");
    expect(p).toContain("uncertainty");
    expect(p).toContain("later user corrections");
    expect(p).not.toContain("no length limit");
  });
  test("review remains read only without a mandatory scoring tool", () => {
    const p = rolePrompt("reviewer");
    expect(p).toContain("Default to inspection");
    expect(p).not.toContain("complexity");
    expect(p).toContain("Never push, publish, merge or deploy without authorization");
    expect(p).not.toContain("no length limit");
  });

  test("role prompts stay bounded and retain terminology", () => {
    for (const role of ["orchestrator", "worker", "reviewer"] as const) {
      const p = rolePrompt(role);
      expect(p.length).toBeLessThan(4000);
      expect(p).toContain("Use the user’s terminology");
      expect(p).not.toMatch(/\{\w+\}/);
    }
  });
  test("user-edited definitions remain present with shipped contracts", () => {
    definition("prompts/orchestrator.md", "old baseline");
    writeFileSync(join(home, "prompts", "orchestrator.md"), "Project rule: review database migrations.");
    const p = rolePrompt("orchestrator");
    expect(p).toContain("review database migrations");
    expect(p).toContain("Honor explicit workflow");
  });
  test("decisions for the user go through ask, so they reach the Questions inbox", () => {
    const p = rolePrompt("orchestrator");
    expect(p).toContain("in the ask tool so it reaches their Questions inbox (Ctrl+Q)");
    expect(p).toContain("a list in chat alone is not asking");
    expect(p).toContain("Close questions answered in chat or outdated (ask close).");
    expect(p).toContain("Ask only for consequential unresolved decisions");
  });
  test("questions retain authorization and silence rules", () => {
    expect(ask.spec.description).toContain("currently unresolved decision");
    expect(ask.spec.description).toContain("Skip, silence and closing the panel never apply it");
    expect(ask.spec.description).toContain("new access, credentials, provider or billing");
  });
});
