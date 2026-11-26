import { MAX_IMAGE_BYTES, validateImage } from "../../api";
import { fail, ok, type Result } from "../../config";
export type ClipboardImage = { bytes: Uint8Array; mime: string };
export type ClipboardAdapter = {
  platform: string;
  env: Record<string, string | undefined>;
  which(name: string): string | null;
  run(argv: string[], limit: number): Promise<Result<Uint8Array>>;
};
export const MAC_CLIPBOARD_SCRIPT = `ObjC.import('AppKit');
ObjC.import('Foundation');
function run() {
  var p = $.NSPasteboard.generalPasteboard, before = Number(p.changeCount);
  var types = ObjC.deepUnwrap(p.types) || [];
  var chosen = ['public.png','public.tiff','public.jpeg'].filter(function(t) { return types.indexOf(t) >= 0; })[0];
  if (!chosen) {
    if (!types.length) throw Error('clipboard is empty.');
    if (types.some(function(t) { return /image|png|tiff|jpeg|gif|webp/i.test(t); })) throw Error('unsupported clipboard image; copy a png, tiff or jpeg.');
    throw Error('clipboard has no image. use your terminal text-paste shortcut for text.');
  }
  var data = p.dataForType(chosen);
  if (!data || Number(data.length) > ${MAX_IMAGE_BYTES}) throw Error('clipboard image exceeds 64 mib or could not be read.');
  if (chosen !== 'public.png') {
    var rep = $.NSBitmapImageRep.imageRepWithData(data);
    if (!rep || Number(rep.pixelsWide) > 4096 || Number(rep.pixelsHigh) > 4096) throw Error('unsupported or oversized clipboard image.');
    data = rep.representationUsingTypeProperties(4, $({}));
  }
  if (!data || Number(data.length) > ${MAX_IMAGE_BYTES}) throw Error('converted clipboard image exceeds 64 mib.');
  if (Number(p.changeCount) !== before) throw Error('clipboard changed while reading; try ctrl+v again.');
  return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}`;
const present = (value: string | undefined): boolean => value !== undefined && value !== "";
const overSsh = (env: Record<string, string | undefined>): boolean => present(env.SSH_CONNECTION) || present(env.SSH_TTY);
const toolFor = (adapter: { env: Record<string, string | undefined>; which(name: string): string | null }, display: string, name: string): string | null =>
  present(adapter.env[display]) ? adapter.which(name) : null;

export async function clipboardCommand(argv: string[], limit: number): Promise<Result<Uint8Array>> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 5000);
  const read = async (stream: ReadableStream<Uint8Array>, max: number): Promise<Buffer | null> => {
    const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > max) { child.kill(); return null; } chunks.push(next.value); } }
    finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  };
  try {
    const [out, err, code] = await Promise.all([read(child.stdout, limit), read(child.stderr, 8192), child.exited]);
    if (out === null || err === null) return fail("clipboard output exceeded size limit.");
    const reason = err.toString().replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1000);
    if (code !== 0) return fail(`clipboard read failed: ${reason !== "" ? reason : "clipboard service unavailable or timed out"}`);
    return ok(out);
  } finally { clearTimeout(timer); child.kill(); }
}
const native: ClipboardAdapter = { platform: process.platform, env: process.env, which: name => Bun.which(name), run: clipboardCommand };

function checkedImage(bytes: Uint8Array): Result<ClipboardImage> {
  const valid = validateImage(bytes);
  return valid.ok ? ok({ bytes, mime: "image/png" }) : valid;
}

async function macImage(adapter: ClipboardAdapter): Promise<Result<Uint8Array>> {
  const run = await adapter.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", MAC_CLIPBOARD_SCRIPT], Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 16);
  if (!run.ok) return run;
  const encoded = Buffer.from(run.data).toString().trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return fail("native clipboard returned invalid image data.");
  return ok(Buffer.from(encoded, "base64"));
}

async function linuxImage(adapter: ClipboardAdapter): Promise<Result<Uint8Array>> {
  const wl = toolFor(adapter, "WAYLAND_DISPLAY", "wl-paste");
  const xclip = toolFor(adapter, "DISPLAY", "xclip");
  const tool = wl ?? xclip;
  if (tool === null) return fail("no local image clipboard available. use an existing wl-paste (wayland) or xclip (x11) in a desktop session; nothing was installed.");
  const listed = await adapter.run(wl !== null ? [tool, "--list-types"] : [tool, "-selection", "clipboard", "-t", "TARGETS", "-o"], 16384);
  if (!listed.ok) return listed;
  const types = Buffer.from(listed.data).toString().split(/\s+/).filter(t => t !== "");
  if (!types.includes("image/png")) return fail(types.some(t => t.startsWith("image/")) ? "unsupported clipboard image; linux supports image/png. copy a png." : "clipboard is empty or has no image. use terminal text paste for text.");
  return adapter.run(wl !== null ? [tool, "--no-newline", "--type", "image/png"] : [tool, "-selection", "clipboard", "-t", "image/png", "-o"], MAX_IMAGE_BYTES);
}

export async function readClipboardImage(adapter: ClipboardAdapter = native): Promise<Result<ClipboardImage>> {
  if (overSsh(adapter.env)) return fail("image clipboard is unavailable over ssh. run orca in the local desktop session; terminal text paste still works.");
  const bytes = adapter.platform === "darwin" ? await macImage(adapter) : adapter.platform === "linux" ? await linuxImage(adapter) : fail("image clipboard is supported only on local macos or linux desktops.");
  return bytes.ok ? checkedImage(bytes.data) : bytes;
}

export type ClipboardWriter = {
  platform: string;
  env: Record<string, string | undefined>;
  which(name: string): string | null;
  run(argv: string[], text: string): Promise<Result<null>>;
};
export async function clipboardWriteCommand(argv: string[], text: string, timeoutMs = 5000): Promise<Result<null>> {
  const child = Bun.spawn(argv, { stdin: new Blob([text]), stdout: "ignore", stderr: "ignore" });
  const deadline = { passed: false };
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    deadline.passed = true;
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), 100);
  }, timeoutMs);
  try {
    const code = await child.exited;
    if (deadline.passed) return fail("clipboard service timed out.");
    if (code !== 0) return fail("clipboard service failed.");
    return ok(null);
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
export async function writeClipboardText(text: string, adapter: ClipboardWriter = { ...native, run: clipboardWriteCommand }): Promise<Result<null>> {
  if (overSsh(adapter.env)) return fail("text copy requires a local desktop session; unavailable over ssh.");
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) return fail("selection exceeds the 4 mib copy limit.");
  if (adapter.platform === "darwin") return adapter.run(["/usr/bin/pbcopy"], text);
  if (adapter.platform !== "linux") return fail("text copy is supported only on local macos or linux desktops.");
  const wl = toolFor(adapter, "WAYLAND_DISPLAY", "wl-copy");
  if (wl !== null) return adapter.run([wl, "--type", "text/plain;charset=utf-8"], text);
  const xclip = toolFor(adapter, "DISPLAY", "xclip");
  if (xclip !== null) return adapter.run([xclip, "-selection", "clipboard", "-in"], text);
  return fail("no local clipboard writer; use existing wl-copy or xclip. nothing was installed.");
}
export async function readClipboardText(adapter: ClipboardAdapter = native): Promise<Result<string>> {
  if (overSsh(adapter.env)) return fail("text paste from the clipboard needs a local desktop session; use your terminal's paste.");
  const limit = 4 * 1024 * 1024;
  let argv: string[] | null = null;
  if (adapter.platform === "darwin") argv = ["/usr/bin/pbpaste"];
  else if (adapter.platform === "linux") {
    const wl = toolFor(adapter, "WAYLAND_DISPLAY", "wl-paste");
    const xclip = toolFor(adapter, "DISPLAY", "xclip");
    argv = wl !== null ? [wl, "--no-newline", "--type", "text/plain"] : xclip !== null ? [xclip, "-selection", "clipboard", "-o"] : null;
  }
  if (argv === null) return fail("no local clipboard reader; use your terminal's paste.");
  const read = await adapter.run(argv, limit);
  return read.ok ? ok(Buffer.from(read.data).toString("utf8")) : read;
}
