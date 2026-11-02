import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationIdentity, paths, updateState } from "../../../config";
import { png } from "../../../test/image-fixture";
import { imageBlock, loadImage, materializeImages, pendingImageInputs, saveImage, saveImageInput } from "./images";

const home = mkdtempSync(join(tmpdir(), "orca-legacy-images-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const project = `p-${crypto.randomUUID()}`;
  mkdirSync(paths.project(project), { recursive: true });
  const stat = lstatSync(paths.project(project), { bigint: true });
  const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  const current = await saveImage(project, png());
  const ref = { ...current, scope: hash(`${project}\0${identity}`) };
  const scope = `project:${project}:${identity}`;
  return { project, identity, current, ref, scope };
}

test("retained pre-UUID prompt/tool references materialize without rewriting references or bytes", async () => {
  const { project, ref, current, scope } = await fixture();
  updateState(paths.memory, scope, "repository", () => ({ directory: "/retained" }));
  const messages = [{ role: "user" as const, content: [imageBlock(ref), {
    type: "tool_result" as const, tool_use_id: "read-1", content: [imageBlock(ref)],
  }] }];
  const before = JSON.stringify(messages), file = join(paths.project(project), "images", `${ref.id}.png`);
  const bytes = readFileSync(file);
  const delivered = JSON.stringify(await materializeImages(project, messages));
  expect(delivered.match(/"type":"base64"/g)).toHaveLength(2);
  expect(JSON.stringify(messages)).toBe(before);
  expect(readFileSync(file)).toEqual(bytes);
  expect((await saveImage(project, png())).scope).toBe(current.scope);
  expect(current.scope).not.toBe(ref.scope);
});

test("legacy aliases added by older workers remain visible after a failed lookup", async () => {
  const { project, ref, scope } = await fixture();
  await expect(loadImage(project, ref)).rejects.toThrow("another/deleted");
  updateState(paths.memory, scope, "model", () => "old-model");
  expect(await loadImage(project, ref)).toEqual(png());
});

test("UUID references need no legacy metadata database", async () => {
  const isolated = mkdtempSync(join(home, "no-database-"));
  process.env.ORCA_HOME = isolated;
  try {
    const { project, current } = await fixture();
    expect(await loadImage(project, current)).toEqual(png());
    expect(() => readFileSync(paths.memory)).toThrow();
  } finally { process.env.ORCA_HOME = home; }
});

test("historical device aliases all work without admitting unknown device scopes", async () => {
  const { project, ref, scope, identity } = await fixture();
  updateState(paths.memory, scope, "model", () => "old");
  const fingerprint = identity.split(":").slice(1).join(":");
  updateState(paths.memory, `project:${project}:42:${fingerprint}`, "model", () => "old");
  expect(await loadImage(project, { ...ref, scope: hash(`${project}\0${42}:${fingerprint}`) })).toEqual(png());
  await expect(loadImage(project, { ...ref, scope: hash(`${project}\0${43}:${fingerprint}`) })).rejects.toThrow("another/deleted");
});

test("copying bytes and retained namespace metadata to a different conversation never grants access", async () => {
  const first = await fixture(), second = await fixture();
  updateState(paths.memory, first.scope, "model", () => "old");
  updateState(paths.memory, second.scope, "model", () => "old");
  cpSync(join(paths.project(first.project), "images"), join(paths.project(second.project), "images"), { recursive: true });
  await expect(loadImage(second.project, first.ref)).rejects.toThrow("another/deleted");
});

test("legacy image journals recover exactly once according to consumption receipts", async () => {
  const { project, ref, scope } = await fixture();
  updateState(paths.memory, scope, "model", () => "old-model");
  const input = { inputId: crypto.randomUUID(), text: "retained screenshot", attachments: [ref] };
  await saveImageInput(project, input);
  expect(await pendingImageInputs(project)).toEqual([input]);
  expect(await pendingImageInputs(project, new Set([input.inputId]))).toEqual([]);
});

test("foreign scopes, wrong fingerprints and malformed device aliases stay unauthorized", async () => {
  const { project, ref, scope, identity } = await fixture();
  updateState(paths.memory, scope.replace(`project:${project}:`, "project:other:"), "model", () => "old");
  updateState(paths.memory, `project:${project}:123:0:0`, "model", () => "old");
  updateState(paths.memory, `project:${project}:invalid:${identity.split(":").slice(1).join(":")}`, "model", () => "old");
  await expect(loadImage(project, ref)).rejects.toThrow("another/deleted");
});

test("recreated conversation cannot inherit old images even when bytes and state remain", async () => {
  const { project, ref, scope } = await fixture();
  updateState(paths.memory, scope, "model", () => "old");
  const copy = join(home, `saved-${crypto.randomUUID()}`);
  cpSync(join(paths.project(project), "images"), copy, { recursive: true });
  rmSync(paths.project(project), { recursive: true });
  mkdirSync(paths.project(project));
  cpSync(copy, join(paths.project(project), "images"), { recursive: true });
  await expect(loadImage(project, ref)).rejects.toThrow("another/deleted");
});

test("saved UUID fingerprint permits restored conversations across device changes, but still checks image hashes", async () => {
  const { project, ref, scope } = await fixture();
  updateState(paths.memory, scope, "model", () => "old");
  const identity = conversationIdentity(paths.root, project);
  const copy = join(home, `restore-${crypto.randomUUID()}`);
  cpSync(paths.project(project), copy, { recursive: true });
  rmSync(paths.project(project), { recursive: true });
  cpSync(copy, paths.project(project), { recursive: true });
  expect(conversationIdentity(paths.root, project)).toEqual(identity);
  expect(await loadImage(project, ref)).toEqual(png());
  writeFileSync(join(paths.project(project), "images", `${ref.id}.png`), png(2));
  await expect(loadImage(project, ref)).rejects.toThrow("corrupt");
});
