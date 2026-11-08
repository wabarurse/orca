import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import { validateImage, type ImageMime } from "../../../providers";
import { run } from "../../proc";

// Pi separates source images from model payload preparation. Orca keeps scoped
// originals and caches a compressed request copy without changing pixel dimensions.
// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md
// 7 MiB becomes under 10 MB in base64, within the current Claude API image limit.
// https://platform.claude.com/docs/en/build-with-claude/vision
const PAYLOAD_BYTES = 7 * 1024 * 1024;
type Image = { bytes: Buffer; mime: ImageMime };
const preparedImages = new Map<string, Image>();

export async function prepareImage(project: string, image: Image, signal?: AbortSignal): Promise<Image> {
  signal?.throwIfAborted();
  if (image.bytes.length <= PAYLOAD_BYTES) return image;
  const key = createHash("sha256").update(image.bytes).digest("hex");
  const cached = preparedImages.get(key);
  if (cached) return cached;
  const dimensions = validateImage(image.bytes, image.mime);
  const dir = join(paths.project(project), "images", "prepared");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const load = async (file: string): Promise<Image | undefined> => {
    const size = await stat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!size || size.size > PAYLOAD_BYTES) return;
    const bytes = await readFile(file);
    if (bytes.length > PAYLOAD_BYTES) return;
    const actual = validateImage(bytes, "image/jpeg");
    if (actual.width !== dimensions.width || actual.height !== dimensions.height) throw new Error("prepared image dimensions changed");
    return { bytes, mime: "image/jpeg" };
  };
  const sips = process.platform === "darwin" ? Bun.which("sips") : undefined;
  const magick = sips ? undefined : Bun.which("magick") ?? Bun.which("convert");
  if (!sips && !magick) throw new Error("image original was saved; sending this large image requires sips (macOS) or ImageMagick to prepare a smaller request copy");
  const temp = await mkdtemp(join(dir, ".prepare-"));
  try {
    const source = join(temp, "source"), output = join(temp, "payload.jpg");
    await Bun.write(source, image.bytes);
    for (const quality of [90, 75, 50]) {
      const argv = sips ? [sips, "-s", "format", "jpeg", "-s", "formatOptions", String(quality), source, "--out", output]
        : [magick!, source, "-strip", "-quality", String(quality), output];
      const result = await run(argv, { cwd: temp, timeoutMs: 20_000, signal });
      if (!result || result.code !== 0) throw new Error("large image request-copy preparation failed; original is retained");
      const prepared = await load(output);
      if (!prepared) continue;
      preparedImages.set(key, prepared);
      if (preparedImages.size > 2) preparedImages.delete(preparedImages.keys().next().value!);
      return prepared;
    }
    throw new Error("image could not fit the provider payload budget at its original pixel dimensions; original is retained");
  } finally { await rm(temp, { recursive: true, force: true }); }
}
