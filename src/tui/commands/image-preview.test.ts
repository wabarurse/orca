import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { png } from "../../test/image-fixture";
import { validateImage } from "../../providers";
import { previewBytes } from "./image-preview";

test("ordinary PNG preview reuses validated source bytes", async () => {
  const source = png(30, 20);
  expect(await previewBytes(source)).toBe(source);
});

test.skipIf(process.platform !== "darwin" || !Bun.which("sips"))("large preview fits terminal bounds without changing the original or leaving temp files", async () => {
  const source = png(3000, 100), original = Buffer.from(source);
  const temps = async () => (await readdir(tmpdir())).filter(name => name.startsWith("orca-image-preview-")).sort();
  const before = await temps(), result = await previewBytes(source);
  const { width, height } = validateImage(result);
  expect(width).toBe(2048); expect(height).toBeLessThanOrEqual(69);
  expect(source.equals(original)).toBe(true);
  expect(await temps()).toEqual(before);
});
