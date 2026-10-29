import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../config";
import { consume, pending } from "../data/inbox";
import { open } from "../data/transcripts";
import { read } from "./files";
import { message } from "./message";
import type { ToolContext } from "./registry";

let home: string, previous: string | undefined, ctx: ToolContext;
beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  home = await mkdtemp(join(tmpdir(), "orca-reports-"));
  process.env.ORCA_HOME = home;
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  await mkdir(paths.project("reports"), { recursive: true });
  ctx = { project: "reports", role: "worker", branch: "work", cwd };
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  await rm(home, { recursive: true, force: true });
});
async function delivered(to = "orchestrator") {
  const texts: string[] = [];
  await consume(ctx.project, to, open(paths.transcript(ctx.project, to)), async inbox => {
    texts.push(...inbox.map(m => m.text));
  });
  return texts;
}

test.each(["worker", "reviewer"] as const)("%s reports enforce the boundary without truncating evidence", async role => {
  ctx = { ...ctx, role };
  const short = "x".repeat(2000);
  await message.run({ to: "orchestrator", text: short }, ctx);
  expect(await delivered()).toEqual([short]);

  const full = "Failure on revision abc123: résumé 🐋\n" + short;
  await expect(message.run({ to: "orchestrator", text: full }, ctx)).rejects.toThrow("report not sent");
  expect(await pending(ctx.project, "orchestrator")).toBe(false);
  const summary = "abc123: validation failed; external dependency unverified. Decision: retry later? ".padEnd(2000, "x");
  await message.run({ to: "orchestrator", text: full, summary }, ctx);
  const reports = await delivered();
  expect(reports).toHaveLength(1);
  expect(reports[0]!.split("\nFull evidence: ")[0]).toBe(summary);
  expect(reports[0]).not.toContain(full);
  const path = reports[0]!.split("\nFull evidence: ")[1]!;
  expect(await readFile(path, "utf8")).toBe(full);
  const evidence = JSON.parse(await read.run({ path, lines: 1 }, { ...ctx, role: "orchestrator" }) as string);
  expect(evidence.content).toContain("Failure on revision abc123: résumé 🐋");
});

test("invalid summaries never enqueue a partial or raw report", async () => {
  for (const summary of [undefined, "", "   ", 3, null, "x".repeat(2001)]) {
    await expect(message.run({ to: "orchestrator", text: "x".repeat(2001), summary }, ctx)).rejects.toThrow("2000");
    expect(await pending(ctx.project, "orchestrator")).toBe(false);
  }
  expect(await delivered()).toEqual([]);
});

test("an explicit summary archives even a short report", async () => {
  const full = "Detailed findings: check one passed; check two failed.";
  await message.run({ to: "orchestrator", text: full, summary: "  Blocked: check two failed.  " }, ctx);
  const [report] = await delivered();
  expect(report!.split("\nFull evidence: ")[0]).toBe("Blocked: check two failed.");
  expect(await readFile(report!.split("\nFull evidence: ")[1]!, "utf8")).toBe(full);
});

test("the report bound does not truncate coordinator instructions or user replies", async () => {
  const full = "User-authorized detail. ".repeat(200);
  for (const to of ["worker-work", "user"]) {
    await message.run({ to, text: full }, { ...ctx, role: "orchestrator", branch: undefined });
    expect(await delivered(to)).toEqual([full.trim()]);
  }
});
