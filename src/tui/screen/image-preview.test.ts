import { expect, test } from "bun:test";
import { imagePreviewUpdate, type ImagePlacement } from "./image-preview";
import type { StickyScreen } from "./sticky";

const frame: StickyScreen = { rows: Array(24).fill(""), cols: 100, cursor: 23, col: 0, bodyTop: 0, bodyHeight: 24, start: 0, maxStart: 0 };
const image: ImagePlacement = { id: "one", data: "eA==", bytes: 1, sourceWidth: 2000, sourceHeight: 1000, row: 4, col: 44,
  width: 56, height: 15, cellWidth: 8, cellHeight: 16 };

test("preview fits both axes, restores cursor and sends no bytes on unchanged frames", () => {
  const output = imagePreviewUpdate(frame, frame, image);
  expect(output).toContain("size=1;width=448px;height=224px;preserveAspectRatio=0:eA==");
  expect(output).toEndWith("\x1b[24;1H");
  expect(imagePreviewUpdate(frame, frame, image, image)).toBe("");
  const tall = imagePreviewUpdate(frame, frame, { ...image, sourceHeight: 4000 });
  expect(tall).toContain("width=120px;height=240px");
});

test("leaving, changing selection, resizing and text overwrites erase old graphics before painting", () => {
  const clear = imagePreviewUpdate(frame, frame, undefined, image);
  expect(clear).toContain("\x1b[5;1H\x1b[0m\x1b[2K");
  expect(clear).not.toContain("1337;File");
  for (const next of [{ ...image, id: "two" }, { ...image, width: 40 }, { ...image, cellWidth: 9 }]) {
    const result = imagePreviewUpdate(frame, frame, next, image);
    expect(result.indexOf("\x1b[2K")).toBeLessThan(result.indexOf("1337;File"));
  }
  const next = { ...frame, rows: [...frame.rows] }; next.rows[6] = "new text in list";
  expect(imagePreviewUpdate(next, frame, image, image)).toContain("1337;File");
  next.rows[6] = ""; next.rows[1] = "new heading outside image";
  expect(imagePreviewUpdate(next, frame, image, image)).not.toContain("1337;File");
});
