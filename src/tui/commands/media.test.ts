import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../config";
import { projectIdentity } from "../../core/data/projects";
import { saveVerification, verificationPaths } from "../../core/data/processes/verification-store";
import { capturedVideos, openDeliveredMedia } from "./media";

const home = mkdtempSync(join(tmpdir(), "orca-media-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
const mp4 = Buffer.from([0, 0, 0, 16, ...Buffer.from("ftypisom"), 0, 0, 0, 0]);
async function fixture() {
  const project = `media-${crypto.randomUUID()}`, id = crypto.randomUUID();
  mkdirSync(paths.project(project), { recursive: true });
  await saveVerification({ project, id, identity: projectIdentity(project), epoch: "fixture", owner: "worker-media", ownerPid: 0,
    source: home, backend: "local", state: "closed", createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() });
  const evidence = verificationPaths(project, id).evidence;
  mkdirSync(evidence, { recursive: true });
  return { project, id, evidence };
}

test("recordings are scoped to registered conversation evidence, including retained closed sessions", async () => {
  const a = await fixture(), b = await fixture();
  mkdirSync(join(a.evidence, "nested"));
  writeFileSync(join(a.evidence, "nested", "demo.mp4"), mp4);
  writeFileSync(join(a.evidence, "notes.txt"), "not media");
  writeFileSync(join(b.evidence, "other.mov"), mp4);
  symlinkSync(b.evidence, join(a.evidence, "external-directory"));
  symlinkSync(join(b.evidence, "other.mov"), join(a.evidence, "external.mov"));
  const rows = await capturedVideos(a.project);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "video", session: a.id, file: "nested/demo.mp4", from: "worker-media" });
  expect((await capturedVideos(a.project))[0]!.id).toBe(rows[0]!.id);
  const opened: string[] = [];
  await openDeliveredMedia(a.project, rows[0]!, async (path, kind) => { expect(kind).toBe("video"); opened.push(path); });
  expect(opened).toEqual([join(a.evidence, "nested", "demo.mp4")]);
  await expect(openDeliveredMedia(b.project, rows[0]!, async () => { throw new Error("must not open"); })).rejects.toThrow();
  rmSync(a.evidence, { recursive: true });
  expect(await capturedVideos(a.project)).toEqual([]);
});

test("activation revalidates recordings and rejects traversal, symlinks and non-video contents", async () => {
  const { project, id, evidence } = await fixture();
  const file = join(evidence, "demo.mp4"); writeFileSync(file, mp4);
  const [media] = await capturedVideos(project);
  let opened = false;
  const viewer = async () => { opened = true; };
  for (const name of ["../demo.mp4", "../../outside.mp4", "/tmp/demo.mp4", "nested/../demo.mp4", "..\\demo.mp4", "demo.html"]) {
    await expect(openDeliveredMedia(project, { ...media!, kind: "video", session: id, file: name }, viewer)).rejects.toThrow();
  }
  writeFileSync(file, "<html>not a recording</html>");
  await expect(openDeliveredMedia(project, media!, viewer)).rejects.toThrow("video header");
  rmSync(file); writeFileSync(join(home, "outside.mp4"), mp4); symlinkSync(join(home, "outside.mp4"), file);
  await expect(openDeliveredMedia(project, media!, viewer)).rejects.toThrow("outside");
  expect(opened).toBe(false);
});

test("discovery refuses symlinked evidence ancestors outside the conversation", async () => {
  const { project, evidence } = await fixture();
  const outputs = join(paths.project(project), "tool-outputs");
  rmSync(outputs, { recursive: true });
  const external = join(home, "external"); mkdirSync(external);
  symlinkSync(external, outputs);
  mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "demo.mp4"), mp4);
  await expect(capturedVideos(project)).rejects.toThrow("outside");
});
