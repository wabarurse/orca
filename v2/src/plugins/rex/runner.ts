import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { fail, ok, parseJson, paths, type Result } from "../../config";
import { exec, launchCommand, readViewer, which, type Attach, type Launch, type Runner, type Viewer } from "../../core/plugins";
import { settled } from "../../core/tools/registry";

const APP_CLI = "/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex";

export function rexBinary(): string | null {
  const dir = process.env.REX_BIN_DIR;
  if (dir !== undefined && dir.length > 0 && existsSync(join(dir, "rex"))) return join(dir, "rex");
  return which("rex") ?? (existsSync(APP_CLI) ? APP_CLI : null);
}

export const sessionName = (conversation: string): string => `orca2-${conversation}`;
export const sharedLabel = (conversation: string, agent: string): string => `${agent}@${conversation}`;
const agentOf = (conversation: string, label: string): string | null => label.endsWith(`@${conversation}`) ? label.slice(0, -conversation.length - 1) : null;

async function viewerSession(conversation: string): Promise<Viewer | null> {
  const viewer = await readViewer(conversation);
  return viewer !== null && viewer.rexSession !== null && viewer.rexBlock !== null ? viewer : null;
}

const marker = (): string => join(paths.globalData, "rex", "used");
export const rexUsed = (): boolean => existsSync(marker());

type Reply = { ok: true; out: string } | { ok: false; gone: boolean; err: string };

async function rex(args: string[]): Promise<Reply> {
  const bin = rexBinary();
  if (bin === null) return { ok: false, gone: true, err: "rex is not installed" };
  const res = await exec([bin, "--autostart=false", ...args]);
  if (!res.ok) return { ok: false, gone: false, err: `rex did not answer: ${res.error}` };
  if (res.data.code === 0) return { ok: true, out: res.data.out };
  const trimmed = res.data.err.trim();
  const err = trimmed.length > 0 ? trimmed : `exit ${res.data.code}`;
  return { ok: false, gone: /no Rex server is running|not found/i.test(err), err };
}

function parse<T>(text: string, schema: z.ZodType<T>): T | null {
  const json = parseJson(text);
  const parsed = json.ok ? schema.safeParse(json.data) : null;
  return parsed !== null && parsed.success ? parsed.data : null;
}

const SessionsSchema = z.looseObject({ sessions: z.array(z.looseObject({ session_id: z.string(), label: z.string() })) });
const WindowsSchema = z.looseObject({ windows: z.array(z.looseObject({
  window_id: z.string(),
  label: z.string(),
  layers: z.array(z.looseObject({ blocks: z.array(z.looseObject({ block_id: z.string(), label: z.string() })) })),
})) });
const ProcessSchema = z.looseObject({ child: z.unknown() });
const CreatedSchema = z.looseObject({ session_id: z.string() });
const ClientsSchema = z.looseObject({ clients: z.array(z.looseObject({ client_id: z.string(), info: z.looseObject({ kind: z.string() }).nullish() })) });
const RunSchema = z.looseObject({ window_id: z.string().nullish(), block_ids: z.array(z.string()).nullish() });

type Block = { id: string; label: string; window: string; windowLabel: string; live: boolean };
type SessionLookup = { kind: "found"; id: string } | { kind: "missing" } | { kind: "unknown" };

async function sessionId(label: string): Promise<SessionLookup> {
  const res = await rex(["ls", "--json"]);
  if (!res.ok) return res.gone ? { kind: "missing" } : { kind: "unknown" };
  const list = parse(res.out, SessionsSchema);
  if (list === null) return { kind: "unknown" };
  const found = list.sessions.find(s => s.label === label);
  return found === undefined ? { kind: "missing" } : { kind: "found", id: found.session_id };
}

async function blocksOf(sid: string): Promise<Block[] | null> {
  const res = await rex(["window", "ls", "-s", sid, "--json"]);
  if (!res.ok) return res.gone ? [] : null;
  const list = parse(res.out, WindowsSchema);
  if (list === null) return null;
  const blocks: Block[] = [];
  for (const window of list.windows) for (const layer of window.layers) for (const block of layer.blocks) {
    const p = await rex(["block", "call", "-b", block.block_id, "process"]);
    if (!p.ok && !p.gone) return null;
    const child: unknown = p.ok ? parse(p.out, ProcessSchema)?.child ?? null : null;
    blocks.push({ id: block.block_id, label: block.label, window: window.window_id, windowLabel: window.label, live: child !== null && child !== undefined });
  }
  return blocks;
}

const agentBlock = (b: Block): boolean => b.label === b.windowLabel && b.label !== "shell";

async function ensureSession(session: string, cwd: string): Promise<Result<string>> {
  const found = await sessionId(session);
  if (found.kind === "found") return ok(found.id);
  if (found.kind === "unknown") return fail("rex could not list its sessions; is Rex running?");
  mkdirSync(join(paths.globalData, "rex"), { recursive: true, mode: 0o700 });
  writeFileSync(marker(), "");
  const res = await rex(["new", session, "-c", cwd, "--window", "shell", "--json"]);
  if (!res.ok) return fail(`rex new failed: ${res.err}`);
  const made = parse(res.out, CreatedSchema)?.session_id;
  if (made !== undefined) return ok(made);
  const again = await sessionId(session);
  return again.kind === "found" ? ok(again.id) : fail(`rex session ${session} did not appear`);
}

async function startBlock(launch: Launch): Promise<Result<string>> {
  if (rexBinary() === null) return fail("Rex is not installed; choose another runner with /mux");
  const viewer = await viewerSession(launch.conversation);
  const shared = viewer?.rexSession ?? null;
  const own = shared === null ? await ensureSession(sessionName(launch.conversation), launch.cwd) : ok(shared);
  if (!own.ok) return own;
  const sid = own;
  const label = shared === null ? launch.agent : sharedLabel(launch.conversation, launch.agent);
  if (shared !== null) {
    mkdirSync(join(paths.globalData, "rex"), { recursive: true, mode: 0o700 });
    writeFileSync(marker(), "");
  }
  for (const block of await blocksOf(sid.data) ?? []) if (block.label === label && !block.live) await rex(["block", "close", block.id]);
  const command = await launchCommand(launch);
  const res = await rex(["run", "-s", sid.data, "--label", label, "-c", launch.cwd, "--keep-open", "--focus=false", "--shell=none", "--json", "--", ...command.argv]);
  const made = res.ok ? parse(res.out, RunSchema) : null;
  const block = made?.block_ids?.[0] ?? "";
  if (!block.startsWith("block:")) {
    await command.cleanup();
    return fail(`rex run failed: ${res.ok ? "unexpected output" : res.err}`);
  }
  const window = made?.window_id;
  if (typeof window === "string") await rex(["window", "rename", "-s", sid.data, window, label]);
  return ok(block);
}

type Found = { session: string; block: Block; shared: boolean };

async function findAgent(conversation: string, agent: string): Promise<Found | null> {
  const viewer = await viewerSession(conversation);
  if (viewer?.rexSession != null) {
    const block = (await blocksOf(viewer.rexSession) ?? []).find(b => b.label === sharedLabel(conversation, agent));
    if (block !== undefined) return { session: viewer.rexSession, block, shared: true };
  }
  const sid = await sessionId(sessionName(conversation));
  if (sid.kind !== "found") return null;
  const block = (await blocksOf(sid.id) ?? []).find(b => b.label === agent && agentBlock(b));
  return block === undefined ? null : { session: sid.id, block, shared: false };
}

async function showInApp(session: string): Promise<void> {
  const clients = await rex(["client", "ls", "--json"]);
  const app = clients.ok ? parse(clients.out, ClientsSchema)?.clients.find(c => c.info?.kind === "app") : undefined;
  if (app !== undefined) await rex(["-C", app.client_id, "do", "session.select", `session_id=${session}`]);
  if (process.platform === "darwin") await exec(["/usr/bin/open", "-a", "Rex"]);
}

async function toggleBeside(conversation: string, agent: string, found: Found, viewer: Viewer): Promise<Result<Attach>> {
  const beside = viewer.rexBlock ?? "";
  const blocks = await blocksOf(found.session) ?? [];
  const viewerWindow = blocks.find(b => b.id === beside)?.window ?? null;
  if (viewerWindow === null) return fail("orca2's own Rex pane is not in this session any more; reopen orca2 in Rex");
  const label = sharedLabel(conversation, agent);
  if (found.block.window === viewerWindow) {
    const made = await rex(["window", "new", "-s", found.session, label, "--keep-open", "--focus=false", "--json", "--", "/bin/sh", "-c", "sleep 600"]);
    const holder = made.ok ? parse(made.out, RunSchema)?.block_ids?.[0] ?? null : null;
    if (holder === null) return fail(`could not open a tab for ${agent}: ${made.ok ? "unexpected output" : made.err}`);
    const moved = await rex(["move", "-s", found.session, found.block.id, "right", holder]);
    await rex(["block", "close", holder]);
    return moved.ok ? ok({ kind: "shown", note: `${agent} is back in its own Rex tab` }) : fail(`could not move ${agent} back: ${moved.err}`);
  }
  const moved = await rex(["move", "-s", found.session, found.block.id, "right", beside, "--ratio", "45"]);
  if (!moved.ok) return fail(`could not open ${agent} beside orca2: ${moved.err}`);
  return ok({ kind: "shown", note: `${agent} is open beside orca2 (attach again to put it back in its tab; closing that pane stops it)` });
}

export const rexRunner: Runner = {
  name: "rex",
  async start(launch) {
    return { handle: settled(await startBlock(launch)), pid: null };
  },
  async alive(conversation) {
    if (!rexUsed() || rexBinary() === null) return [];
    const names = new Set<string>();
    const viewer = await viewerSession(conversation);
    if (viewer?.rexSession != null) {
      const shared = await blocksOf(viewer.rexSession);
      if (shared === null) return null;
      for (const b of shared) { const agent = agentOf(conversation, b.label); if (b.live && agent !== null) names.add(agent); }
    }
    const sid = await sessionId(sessionName(conversation));
    if (sid.kind === "unknown") return null;
    if (sid.kind === "found") {
      const blocks = await blocksOf(sid.id);
      if (blocks === null) return null;
      for (const b of blocks) if (b.live && agentBlock(b)) names.add(b.label);
    }
    return [...names];
  },
  async attach(conversation, label) {
    if (rexBinary() === null) return fail("Rex is not installed");
    const found = await findAgent(conversation, label);
    if (found === null) return fail(`${label} has no Rex window (it may have ended)`);
    const viewer = await viewerSession(conversation);
    if (found.shared && viewer !== null) return toggleBeside(conversation, label, found, viewer);
    await rex(["focus", "-s", found.session, found.block.window]);
    await showInApp(found.session);
    return ok({ kind: "shown", note: `showing ${label} in Rex` });
  },
  async stop(conversation, agent) {
    if (!rexUsed()) return;
    const viewer = await viewerSession(conversation);
    if (viewer?.rexSession != null) {
      const shared = await blocksOf(viewer.rexSession) ?? [];
      const windowLabel = new Map(shared.map(b => [b.window, b.windowLabel]));
      for (const b of shared.filter(x => x.label === sharedLabel(conversation, agent))) {
        if (windowLabel.get(b.window) === b.label) await rex(["window", "close", "-s", viewer.rexSession, b.window]);
        else await rex(["block", "close", b.id]);
      }
    }
    const sid = await sessionId(sessionName(conversation));
    if (sid.kind !== "found") return;
    const windows = new Set((await blocksOf(sid.id) ?? []).filter(b => b.label === agent && agentBlock(b)).map(b => b.window));
    for (const window of windows) await rex(["window", "close", "-s", sid.id, window]);
  },
};
