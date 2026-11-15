import { expect, test } from "bun:test";
import { ImageOverlay } from "./image-overlay";
import type { Terminal } from "./term";

function fakeTerm(protocol: "kitty" | null): Terminal & { out: string } {
  const t = { out: "", cols: 80, rows: 24, imageProtocol: protocol,
    write(s: string) { t.out += s; }, onKey() {}, onResize() {}, open() {}, close() {}, eraseOnExit() {} } as Terminal & { out: string };
  return t;
}

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

test("open draws on a kitty terminal and marks itself active", () => {
  const term = fakeTerm("kitty"), overlay = new ImageOverlay();
  expect(overlay.open(term, "shot.png", png(800, 600))).toBe(true);
  expect(overlay.active).toBe(true);
  expect(term.out).toContain("\x1b_G"); // a kitty graphics escape went out
  expect(term.out).toContain("shot.png"); // the name is shown as a hint
});

test("open refuses a terminal with no image protocol", () => {
  const term = fakeTerm(null), overlay = new ImageOverlay();
  expect(overlay.open(term, "shot.png", png(800, 600))).toBe(false);
  expect(overlay.active).toBe(false);
  expect(term.out).toBe("");
});

test("open refuses bytes that are not a PNG", () => {
  const term = fakeTerm("kitty"), overlay = new ImageOverlay();
  expect(overlay.open(term, "clip.gif", new Uint8Array([0x47, 0x49, 0x46]))).toBe(false);
  expect(overlay.active).toBe(false);
});

test("show falls back to false when loading the bytes throws", async () => {
  const term = fakeTerm("kitty"), overlay = new ImageOverlay();
  expect(await overlay.show(term, async () => { throw new Error("gone"); })).toBe(false);
  expect(overlay.active).toBe(false);
});

test("close clears the image and the active flag", () => {
  const term = fakeTerm("kitty"), overlay = new ImageOverlay();
  overlay.open(term, "shot.png", png(800, 600));
  term.out = "";
  overlay.close(term);
  expect(overlay.active).toBe(false);
  expect(term.out).toContain("\x1b_Ga=d"); // delete-all escape
});
