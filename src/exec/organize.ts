// Offline, resumable storage move. Never stop, restart or signal participants.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { conversationIds, conversationIdentity, organizeConversationStorage, paths } from "../config";
import { lockHeld, tryStorageLock } from "../core/data";
import { directories } from "../core/data/projects";
import { listProcesses, liveProcess } from "../core/data/processes";
import { tmux } from "../core/tmux";

async function inspect(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { cwd: paths.root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`cannot verify Orca participants (${argv[0]}): ${err.trim()}; storage was left unchanged`);
    return out;
  } finally { clearTimeout(timeout); }
}

export function orcaParticipantIds(snapshot: string, self = process.pid): string[] {
  return snapshot.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === self) return [];
    // Match the executable/script, not a shell/SSH parent whose arguments merely
    // mention the organizer command being run.
    return /^(?:\S*\/)?orca(?:\s|$)|^(?:\S*\/)?bun(?:\s+run)?\s+(?:\S*\/)?src\/cli\/main\.ts(?:\s|$)/.test(match[2]!) ? [`Orca process ${match[1]}`] : [];
  });
}
async function participants(): Promise<string[]> {
  const active = orcaParticipantIds(await inspect(["ps", "-axo", "pid=,command="]));
  if (existsSync(paths.tmuxSocket)) {
    const panes = await inspect(tmux.argv("list-panes", "-a", "-F", "#{pane_dead}"));
    if (panes.split("\n").some(line => line.trim() === "0")) active.push("an open Orca tmux session");
  }
  return active;
}
/** Tests replace only the host inventory; durable locks/process checks stay real. */
export async function organizeProjects(inventory = participants): Promise<number> {
  const release = await tryStorageLock(join(paths.runtime, "storage-organization"));
  if (!release) throw new Error("another storage organization is running; try again after it finishes");
  try {
    const active = await inventory();
    if (active.length) throw new Error(`close Orca TUIs and stop its sessions before organizing: ${active.join(", ")}. Nothing was moved.`);
    if (await lockHeld(join(paths.runtime, "project-folders.lock"))) throw new Error("project folders are being updated; nothing was moved");
    const ids = conversationIds(paths.root, true);
    // Complete every preflight before the first move, including uncertain owners.
    for (const id of ids) {
      for (const kind of ["turn-locks", "project-locks", "daemon-locks"]) {
        if (await lockHeld(join(paths.runtime, kind, id))) throw new Error(`${id} still has a participant; nothing was moved`);
      }
      if ((await listProcesses(id)).some(p => liveProcess(p) || p.state === "unknown")) throw new Error(`${id} has an unresolved background process; nothing was moved`);
      if (existsSync(join(paths.project(id), "repo")) || existsSync(join(paths.project(id), "worktrees"))) {
        throw new Error(`${id} has legacy in-folder Git workspaces; relocate/recover these explicitly before organizing. Nothing was moved.`);
      }
    }
    for (const id of ids) conversationIdentity(paths.root, id);
    const moved = organizeConversationStorage(paths.root);
    await directories.directoryProjects(); // Attach saved bindings and publish named views.
    return moved;
  } finally { await release(); }
}
