import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { paths } from "../../config";
import { run } from "../../core";
import { imageFile } from "../../core/data/images";
import { listVerifications, readVerification, verificationPaths } from "../../core/data/processes";
import { workspaces } from "../../core/data/projects";
import type { DeliveredImage } from "./images";

export type DeliveredMedia = ({ kind: "image" } & DeliveredImage | {
  kind: "video"; session: string; file: string; from: string; text: string; at: string;
}) & { id: string; archived?: boolean };
const videoExtension = (file: string) => [".mp4", ".mov", ".m4v", ".webm"].includes(extname(file).toLowerCase());
const within = (root: string, path: string) => path.startsWith(root + sep);

/** Discover only retained recordings in this conversation's registered evidence.
 * Called when opening/refreshing the media page, never on every TUI redraw. */
export async function capturedVideos(project: string): Promise<DeliveredMedia[]> {
  const result: DeliveredMedia[] = [];
  for (const session of await listVerifications(project)) {
    const root = verificationPaths(project, session.id).evidence;
    const projectRoot = await realpath(paths.project(project));
    const visit = async (directory: string): Promise<void> => {
      const info = await lstat(directory).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
      if (!info || !info.isDirectory() || info.isSymbolicLink()) return;
      if (!within(projectRoot, await realpath(directory))) throw new Error("recording is outside this project's evidence");
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) await visit(path);
        else if (item.isFile() && videoExtension(item.name)) {
          const file = relative(root, path);
          const stat = await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
          if (!stat?.isFile() || stat.isSymbolicLink()) continue;
          result.push({ kind: "video", id: "video-" + createHash("sha256").update(`${session.id}\0${file}`).digest("hex").slice(0, 24),
            session: session.id, file, from: session.owner, text: `Video · ${file}`, at: stat.mtime.toISOString(),
            archived: !!workspaces.archived(project, "sandbox", session.id) });
        }
      }
    };
    await visit(root);
  }
  return result.sort((a, b) => b.at.localeCompare(a.at));
}

async function recordingFile(project: string, media: Extract<DeliveredMedia, { kind: "video" }>): Promise<string> {
  await readVerification(project, media.session); // Recheck project generation and ownership at activation.
  if (!videoExtension(media.file) || media.file.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new Error("invalid recording path");
  const root = verificationPaths(project, media.session).evidence;
  const file = join(root, media.file);
  const projectRoot = await realpath(paths.project(project));
  const resolvedRoot = await realpath(root), resolvedFile = await realpath(file);
  if (!within(projectRoot, resolvedRoot) || !within(resolvedRoot, resolvedFile) || (await lstat(file)).isSymbolicLink()) throw new Error("recording is outside this project's evidence");
  const handle = await open(file, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error("recording is not a regular file");
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const webm = bytes.readUInt32BE(0) === 0x1a45dfa3;
    const movie = ["ftyp", "moov", "mdat", "wide", "free"].includes(bytes.toString("ascii", 4, 8));
    if (bytesRead < 8 || (!webm && !movie)) throw new Error("recording has an unsupported or incomplete video header");
  } finally { await handle.close(); }
  return file;
}

/** Explicit Enter only; never open files as a side effect of navigation. */
export async function openDeliveredMedia(project: string, media: DeliveredMedia, opener?: (path: string, kind: "image" | "video") => Promise<void>): Promise<string> {
  const path = media.kind === "image" ? await imageFile(project, media.ref) : await recordingFile(project, media);
  if (opener) await opener(path, media.kind);
  else {
    if (process.env.SSH_CONNECTION || process.env.SSH_TTY) throw new Error(`Media is on the remote machine: ${path}. Copy it locally to view.`);
    const command = process.platform === "darwin" ? "/usr/bin/open" : Bun.which("xdg-open");
    if (!command) throw new Error(`No desktop viewer available. File: ${path}`);
    const args = process.platform === "darwin" && media.kind === "image" ? [command, "-a", "Preview", path] : [command, path];
    const result = await run(args, { cwd: "/", timeoutMs: 10_000 });
    if (!result || result.code !== 0) throw new Error(`Could not open the desktop viewer. File: ${path}`);
  }
  return `Opened ${basename(path)} in the desktop viewer.`;
}
