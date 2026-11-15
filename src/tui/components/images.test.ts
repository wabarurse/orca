import { expect, test } from "bun:test";
import { fitCells, imageProtocol, kittyClear, kittyImage, pngSize } from "./images";

test("imageProtocol detects kitty-family terminals and nothing else", () => {
  expect(imageProtocol({ TERM: "xterm-ghostty" })).toBe("kitty");
  expect(imageProtocol({ TERM_PROGRAM: "ghostty" })).toBe("kitty");
  expect(imageProtocol({ GHOSTTY_RESOURCES_DIR: "/x" })).toBe("kitty");
  expect(imageProtocol({ TERM: "xterm-kitty" })).toBe("kitty");
  expect(imageProtocol({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
  expect(imageProtocol({ TERM_PROGRAM: "WezTerm" })).toBe("kitty");
  expect(imageProtocol({ TERM: "xterm-256color" })).toBeNull();
  expect(imageProtocol({ TERM_PROGRAM: "Apple_Terminal" })).toBeNull();
  expect(imageProtocol({})).toBeNull();
});

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

test("pngSize reads IHDR and rejects non-PNG bytes", () => {
  expect(pngSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull();
  expect(pngSize(new Uint8Array(24))).toBeNull(); // right length, wrong signature
});

test("fitCells keeps aspect ratio and fills the binding side", () => {
  // A 1000x1000 image, cells 10x20: 100 cols x 50 rows wanted. Box 80x40: rows bind (40/50 < 80/100).
  const landscape = fitCells({ width: 1000, height: 1000 }, { width: 10, height: 20 }, { cols: 80, rows: 40 });
  expect(landscape.rows).toBe(40);
  expect(landscape.cols).toBe(80); // square source, square cell box after the 2:1 cell correction
  // Wide image binds on cols.
  const wide = fitCells({ width: 2000, height: 500 }, { width: 10, height: 20 }, { cols: 80, rows: 40 });
  expect(wide.cols).toBe(80);
  expect(wide.rows).toBeLessThan(40);
  // Never zero.
  expect(fitCells({ width: 1, height: 1 }, { width: 10, height: 20 }, { cols: 80, rows: 40 }).cols).toBeGreaterThanOrEqual(1);
});

test("kittyImage chunks the payload with the continuation flag and sets size", () => {
  const small = kittyImage(new Uint8Array([1, 2, 3]), { cols: 10, rows: 5 });
  expect(small).toContain("a=T,f=100,c=10,r=5,m=0");
  expect(small.startsWith("\x1b_G")).toBe(true);
  expect(small.endsWith("\x1b\\")).toBe(true);

  const big = kittyImage(new Uint8Array(6000), { cols: 20, rows: 10 }); // base64 ~8000 chars -> 2 chunks
  const escapes = big.split("\x1b\\").filter(Boolean);
  expect(escapes.length).toBe(2);
  expect(escapes[0]).toContain("a=T,f=100,c=20,r=10,m=1"); // first: controls + more
  expect(escapes[1]).toContain("\x1b_Gm=0;"); // last: continuation only, more=0
  expect(escapes[1]).not.toContain("a=T");
});

test("kittyClear deletes all images", () => {
  expect(kittyClear()).toBe("\x1b_Ga=d\x1b\\");
});
