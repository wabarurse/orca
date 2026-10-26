/** On-demand only. Embedded JXA uses system AppKit; no desktop automation,
 * Swift compilation, helper download, Bun runtime or native addon at runtime. */
import { MAX_IMAGE_BYTES, validateImage } from "../../providers/images";
export interface ClipboardImage { bytes: Uint8Array; mime: string }
export interface ClipboardAdapter {
  platform: string;
  env: Record<string, string | undefined>;
  which(name: string): string | null;
  run(argv: string[], limit: number): Promise<Uint8Array>;
}
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
  if (!data || Number(data.length) > ${MAX_IMAGE_BYTES}) throw Error('clipboard image exceeds 4 mib or could not be read.');
  if (chosen !== 'public.png') {
    var rep = $.NSBitmapImageRep.imageRepWithData(data);
    if (!rep || Number(rep.pixelsWide) > 4096 || Number(rep.pixelsHigh) > 4096) throw Error('unsupported or oversized clipboard image.');
    data = rep.representationUsingTypeProperties(4, $({}));
  }
  if (!data || Number(data.length) > ${MAX_IMAGE_BYTES}) throw Error('converted clipboard image exceeds 4 mib.');
  if (Number(p.changeCount) !== before) throw Error('clipboard changed while reading; try ctrl+v again.');
  return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}`;
/** Bounded subprocess streams and lifetime; stderr is never image output. */
export async function clipboardCommand(argv: string[], limit: number): Promise<Uint8Array> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 5000);
  const read = async (stream: ReadableStream<Uint8Array>, max: number) => {
    const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > max) { child.kill(); throw new Error("clipboard output exceeded size limit."); } chunks.push(next.value); } }
    finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  };
  try {
    const [out, err, code] = await Promise.all([read(child.stdout, limit), read(child.stderr, 8192), child.exited]);
    if (code !== 0) throw new Error(`clipboard read failed: ${err.toString().replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1000) || "clipboard service unavailable or timed out"}`);
    return out;
  } finally { clearTimeout(timer); child.kill(); }
}
const native: ClipboardAdapter = { platform: process.platform, env: process.env, which: name => Bun.which(name), run: clipboardCommand };
export async function readClipboardImage(adapter: ClipboardAdapter = native): Promise<ClipboardImage> {
  if (adapter.env.SSH_CONNECTION || adapter.env.SSH_TTY) throw new Error("image clipboard is unavailable over ssh. run orca in the local desktop session; terminal text paste still works.");
  let bytes: Uint8Array;
  if (adapter.platform === "darwin") {
    const encoded = Buffer.from(await adapter.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", MAC_CLIPBOARD_SCRIPT], Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 16)).toString().trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("native clipboard returned invalid image data.");
    bytes = Buffer.from(encoded, "base64");
  } else if (adapter.platform === "linux") {
    const wl = adapter.env.WAYLAND_DISPLAY && adapter.which("wl-paste");
    const xclip = adapter.env.DISPLAY && adapter.which("xclip");
    if (!wl && !xclip) throw new Error("no local image clipboard available. use an existing wl-paste (wayland) or xclip (x11) in a desktop session; nothing was installed.");
    const command = wl ? [wl, "--list-types"] : [xclip as string, "-selection", "clipboard", "-t", "TARGETS", "-o"];
    const types = Buffer.from(await adapter.run(command, 16384)).toString().split(/\s+/).filter(Boolean);
    if (!types.includes("image/png")) throw new Error(types.some(t => t.startsWith("image/")) ? "unsupported clipboard image; linux supports image/png. copy a png." : "clipboard is empty or has no image. use terminal text paste for text.");
    bytes = await adapter.run(wl ? [wl, "--no-newline", "--type", "image/png"] : [xclip as string, "-selection", "clipboard", "-t", "image/png", "-o"], MAX_IMAGE_BYTES);
  } else throw new Error("image clipboard is supported only on local macos or linux desktops.");
  validateImage(bytes);
  return { bytes, mime: "image/png" };
}

/** Bounded text copy. Fixed argv + stdin, never a shell or OSC 52.
 * SSH cannot address the local desktop. */
export interface ClipboardWriter {
  platform: string;
  env: Record<string, string | undefined>;
  which(name: string): string | null;
  run(argv: string[], text: string): Promise<void>;
}
/** Deadline includes an explicit failure state: a TERM handler exiting zero is
 * still a timeout. Escalate after a short grace period, then await exit to reap.
 * The optional deadline is for isolated subprocess tests, not user input. */
export async function clipboardWriteCommand(argv: string[], text: string, timeoutMs = 5000): Promise<void> {
  const child = Bun.spawn(argv, { stdin: new Blob([text]), stdout: 'ignore', stderr: 'ignore' });
  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    escalation = setTimeout(() => child.kill('SIGKILL'), 100);
  }, timeoutMs);
  try {
    const code = await child.exited;
    if (timedOut) throw new Error('clipboard service timed out.');
    if (code !== 0) throw new Error('clipboard service failed.');
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
}
export async function writeClipboardText(text: string, adapter: ClipboardWriter = { ...native, run: clipboardWriteCommand }): Promise<void> {
  if (adapter.env.SSH_CONNECTION || adapter.env.SSH_TTY) throw new Error('text copy requires a local desktop session; unavailable over ssh.');
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('selection exceeds the 4 mib copy limit.');
  let argv: string[];
  if (adapter.platform === 'darwin') argv = ['/usr/bin/pbcopy'];
  else if (adapter.platform === 'linux') {
    const wl = adapter.env.WAYLAND_DISPLAY && adapter.which('wl-copy');
    const xclip = adapter.env.DISPLAY && adapter.which('xclip');
    if (wl) argv = [wl, '--type', 'text/plain;charset=utf-8'];
    else if (xclip) argv = [xclip, '-selection', 'clipboard', '-in'];
    else throw new Error('no local clipboard writer; use existing wl-copy or xclip. nothing was installed.');
  } else throw new Error('text copy is supported only on local macos or linux desktops.');
  await adapter.run(argv, text);
}
