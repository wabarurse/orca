import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import { validateImage, type ImageMime } from "../../../providers";
import { run } from "../../proc";

// Pi separates source images from model payload preparation. Orca keeps scoped
// originals and caches a request copy; dimensions only change for a provider limit.
// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md
// 7 MiB becomes under 10 MB in base64, within the current Claude API image limit.
// https://platform.claude.com/docs/en/build-with-claude/vision
const PAYLOAD_BYTES = 7 * 1024 * 1024;
type Image = { bytes: Buffer; mime: ImageMime };
const preparedImages = new Map<string, Image>();

export async function prepareImage(project: string, image: Image, signal?: AbortSignal, maxDimension = Infinity): Promise<Image> {
  signal?.throwIfAborted();
  // loadTypedImage already validated the source. Most requests need no extra
  // decoding or hashing; keep their existing fast path and exact bytes.
  if (image.bytes.length <= PAYLOAD_BYTES && maxDimension === Infinity) return image;
  const key = `${createHash("sha256").update(image.bytes).digest("hex")}:${maxDimension}`;
  const cached = preparedImages.get(key);
  if (cached) return cached;
  const dimensions = validateImage(image.bytes, image.mime);
  const resize = Math.max(dimensions.width, dimensions.height) > maxDimension;
  if (image.bytes.length <= PAYLOAD_BYTES && !resize) return image;
  const dir = join(paths.project(project), "images", "prepared");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const load = async (file: string, mime: ImageMime): Promise<Image | undefined> => {
    const size = await stat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!size || size.size > PAYLOAD_BYTES) return;
    const bytes = await readFile(file);
    if (bytes.length > PAYLOAD_BYTES) return;
    const actual = validateImage(bytes, mime);
    if (resize ? Math.max(actual.width, actual.height) > maxDimension
      || Math.abs(actual.width / actual.height - dimensions.width / dimensions.height) > 2 / actual.height
      : actual.width !== dimensions.width || actual.height !== dimensions.height) throw new Error("prepared image dimensions are invalid");
    return { bytes, mime };
  };
  const sips = process.platform === "darwin" ? Bun.which("sips") : undefined;
  const magick = sips ? undefined : Bun.which("magick") ?? Bun.which("convert");
  if (!sips && !magick) throw new Error("image original was saved; sending this image requires sips (macOS) or ImageMagick to prepare a request copy within provider limits. Run /compact to archive older images.");
  const temp = await mkdtemp(join(dir, ".prepare-"));
  try {
    const source = join(temp, "source");
    await Bun.write(source, image.bytes);
    // Prefer PNG when shrinking screenshots: avoid JPEG artifacts around text.
    for (const quality of resize ? [null, 90, 75, 50] : [90, 75, 50]) {
      const mime = quality === null ? "image/png" : "image/jpeg", output = join(temp, quality === null ? "payload.png" : "payload.jpg");
      const argv = sips ? [sips, ...(resize ? ["-Z", String(maxDimension)] : []), "-s", "format", quality === null ? "png" : "jpeg",
        ...(quality === null ? [] : ["-s", "formatOptions", String(quality)]), source, "--out", output]
        : [magick!, source, ...(resize ? ["-resize", `${maxDimension}x${maxDimension}>`] : []), "-strip",
          ...(quality === null ? [] : ["-quality", String(quality)]), output];
      const result = await run(argv, { cwd: temp, timeoutMs: 20_000, signal });
      if (!result || result.code !== 0) throw new Error("large image request-copy preparation failed; original is retained");
      const prepared = await load(output, mime);
      if (!prepared) continue;
      preparedImages.set(key, prepared);
      if (preparedImages.size > 2) preparedImages.delete(preparedImages.keys().next().value!);
      return prepared;
    }
    throw new Error("image could not fit the provider payload budget; original is retained. Run /compact to archive older images.");
  } finally { await rm(temp, { recursive: true, force: true }); }
}
