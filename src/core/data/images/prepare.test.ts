import { afterAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../../../config";
import { prepareImage } from "./prepare";
import { saveImage, imageBlock, loadImage, materializeImages } from "./images";
import { read } from "../../tools/files";
import { readClipboardImage } from "../../../tui/components/clipboard";
import { validatedBase64, validateImage } from "../../../providers/images";
import { png } from "../../../test/image-fixture";
const previous = process.env.ORCA_HOME;
const root = await mkdtemp(join(tmpdir(), "orca-large-image-"));
process.env.ORCA_HOME = root;
afterAll(async () => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; await rm(root, { recursive: true, force: true }); });
function photo(width: number, height: number) {
  const stride = width * 4 + 1, pixels = randomBytes(stride * height);
  for (let y = 0; y < height; y++) { pixels[y * stride] = 0; for (let x = 0; x < width; x++) pixels[y * stride + x * 4 + 4] = 255; }
  return png(width, height, 128, pixels);
}
test("photos larger than 4 MiB survive read, clipboard, storage and request validation", async () => {
  const project = "source", cwd = join(root, "workspace");
  await mkdir(paths.project(project), { recursive: true }); await mkdir(cwd);
  const bytes = photo(1400, 1100);
  expect(bytes.length).toBeGreaterThan(4 * 1024 * 1024);
  await Bun.write(join(cwd, "photo.png"), bytes);
  const result = await read.run({ path: "photo.png" }, { project, cwd, role: "worker" });
  expect(Array.isArray(result)).toBe(true);
  const image = await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "fixture" }, which: name => name,
    run: async args => args.includes("--list-types") ? Buffer.from("image/png") : bytes });
  expect(image.bytes.byteLength).toBe(bytes.length);
  const ref = await saveImage(project, bytes);
  const out = await materializeImages(project, [{ role: "user", content: [imageBlock(ref)] }]);
  const block = (out[0]!.content as any[])[0];
  expect(validatedBase64(block).data).toBe(bytes.toString("base64"));
});
test.skipIf(process.platform !== "darwin" || !Bun.which("sips"))("large request copies retain dimensions, original bytes and cached preparation", async () => {
  const project = "payload"; await mkdir(paths.project(project), { recursive: true });
  const bytes = photo(1900, 1500);
  expect(bytes.length).toBeGreaterThan(7 * 1024 * 1024);
  const ref = await saveImage(project, bytes);
  const prepared = await prepareImage(project, { bytes, mime: "image/png" });
  expect(prepared.bytes.length).toBeLessThanOrEqual(7 * 1024 * 1024);
  expect(validateImage(prepared.bytes, prepared.mime)).toEqual({ width: 1900, height: 1500 });
  expect(await prepareImage(project, { bytes, mime: "image/png" })).toBe(prepared);
  const [request] = await materializeImages(project, [{ role: "user", content: [imageBlock(ref)] }]);
  expect(validatedBase64((request!.content as any[])[0]).mime).toBe("image/jpeg");
  expect(await Bun.file(join(paths.project(project), "images", `${ref.id}.png`)).bytes()).toHaveLength(bytes.length);
  expect(await readdir(join(paths.project(project), "images", "prepared"))).toEqual([]);
});

test.skipIf(!Bun.which("sips") && !Bun.which("magick") && !Bun.which("convert"))("41 historical prompt images prepare a provider-safe copy of a 2816x4048 screenshot", async () => {
  const project = "many-images", bytes = png(2816, 4048);
  await mkdir(paths.project(project), { recursive: true });
  const ref = await saveImage(project, bytes), small = await saveImage(project, png());
  const messages = [{ role: "user" as const, content: [imageBlock(ref), ...Array.from({ length: 40 }, () => imageBlock(small))] }];
  const original = JSON.stringify(messages);
  const [request] = await materializeImages(project, messages);
  const blocks = request!.content as any[];
  expect(blocks).toHaveLength(41);
  for (const block of blocks) {
    const image = validatedBase64(block), size = validateImage(Buffer.from(image.data, "base64"), image.mime);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(3000);
  }
  const prepared = await prepareImage(project, { bytes, mime: "image/png" }, undefined, 3000);
  expect(prepared.mime).toBe("image/png");
  expect(validateImage(prepared.bytes, prepared.mime).height).toBe(3000);
  expect(await prepareImage(project, { bytes, mime: "image/png" }, undefined, 3000)).toBe(prepared);
  expect(await loadImage(project, ref)).toEqual(bytes);
  expect(JSON.stringify(messages)).toBe(original);
  expect(await readdir(join(paths.project(project), "images", "prepared"))).toEqual([]);
  // A subsequent small request must not reuse the many-image downscale.
  const single = await materializeImages(project, [{ role: "user", content: [imageBlock(ref)] }]);
  expect(validatedBase64((single[0]!.content as any[])[0]).data).toBe(bytes.toString("base64"));
});
