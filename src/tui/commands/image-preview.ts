import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../core/proc";
import { sniffImage, validateImage } from "../../providers";

/** Bound terminal decoding/transfer, not the stored original. Stable xterm IIP
 * accepts PNG/JPEG/GIF, but needs WebP converted before sending it. Temporary
 * copies are removed even when conversion fails; no persistent preview cache. */
export async function previewBytes(original: Buffer): Promise<Buffer> {
  const mime = sniffImage(original), { width, height } = validateImage(original, mime);
  if (mime !== "image/webp" && Math.max(width, height) <= 2048 && original.length <= 8 * 1024 * 1024) return original;
  const sips = process.platform === "darwin" ? Bun.which("sips") : undefined;
  const magick = sips ? undefined : Bun.which("magick") ?? Bun.which("convert");
  if (!sips && !magick) throw new Error("This image needs ImageMagick for an inline preview. The original is saved unchanged.");
  const temp = await mkdtemp(join(tmpdir(), "orca-image-preview-"));
  try {
    const source = join(temp, "source"), output = join(temp, "preview.png");
    await writeFile(source, original, { mode: 0o600 });
    const args = sips ? [sips, "-s", "format", "png", "-Z", String(Math.min(2048, Math.max(width, height))), source, "--out", output]
      : [magick!, source + "[0]", "-thumbnail", "2048x2048>", "-strip", "PNG32:" + output];
    const result = await run(args, { cwd: temp, timeoutMs: 20_000 });
    if (!result || result.code !== 0) throw new Error("Could not prepare this image preview. The original is saved unchanged.");
    const preview = await readFile(output);
    validateImage(preview, "image/png");
    // Still below the renderer's 20 MB IIP limit even for a 16-bit RGBA PNG.
    if (preview.length >= 20_000_000) throw new Error("The preview exceeds the terminal's image capacity. The original is saved unchanged.");
    return preview;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
