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

const ListedSchema = z.looseObject({ blocks: z.array(z.looseObject({ block_id: z.string(), label: z.string(), window_id: z.string().nullish() })) });

async function api(method: string, input: Record<string, unknown>): Promise<Reply> {
  return rex(["api", "call", method, JSON.stringify(input)]);
}

async function sharedBlocks(sid: string): Promise<Block[] | null> {
  const res = await api("session.list_blocks", { session_id: sid });
  if (!res.ok) return res.gone ? [] : null;
  const list = parse(res.out, ListedSchema);
  if (list === null) return null;
  const blocks: Block[] = [];
  for (const block of list.blocks) {
    const p = await rex(["block", "call", "-b", block.block_id, "process"]);
    if (!p.ok && !p.gone) return null;
    const child: unknown = p.ok ? parse(p.out, ProcessSchema)?.child ?? null : null;
    blocks.push({ id: block.block_id, label: block.label, window: block.window_id ?? "", windowLabel: "", live: child !== null && child !== undefined });
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
  const label = sharedLabel(launch.conversation, launch.agent);
  mkdirSync(join(paths.globalData, "rex"), { recursive: true, mode: 0o700 });
  writeFileSync(marker(), "");
  for (const block of await sharedBlocks(sid.data) ?? []) if ((block.label === label || block.label === launch.agent) && !block.live) await rex(["block", "close", block.id]);
  const command = await launchCommand(launch);
  const res = await rex(["run", "-s", sid.data, "--label", label, "-c", launch.cwd, "--keep-open", "--focus=false", "--shell=none", "--json", "--", ...command.argv]);
  const made = res.ok ? parse(res.out, RunSchema) : null;
  const block = made?.block_ids?.[0] ?? "";
  if (!block.startsWith("block:")) {
    await command.cleanup();
    return fail(`rex run failed: ${res.ok ? "unexpected output" : res.err}`);
  }
  await api("session.detach_block", { session_id: sid.data, block_id: block });
  return ok(block);
}

type Found = { session: string; block: Block; shared: boolean };

async function findAgent(conversation: string, agent: string): Promise<Found | null> {
  const viewer = await viewerSession(conversation);
  if (viewer?.rexSession != null) {
    const block = (await sharedBlocks(viewer.rexSession) ?? []).find(b => b.label === sharedLabel(conversation, agent));
    if (block !== undefined) return { session: viewer.rexSession, block, shared: true };
  }
  const sid = await sessionId(sessionName(conversation));
  if (sid.kind !== "found") return null;
  const hidden = (await sharedBlocks(sid.id) ?? []).find(b => b.label === sharedLabel(conversation, agent));
  if (hidden !== undefined) return { session: sid.id, block: hidden, shared: false };
  const block = (await blocksOf(sid.id) ?? []).find(b => b.label === agent && agentBlock(b));
  return block === undefined ? null : { session: sid.id, block, shared: false };
}

async function showInApp(session: string): Promise<void> {
  const clients = await rex(["client", "ls", "--json"]);
  const app = clients.ok ? parse(clients.out, ClientsSchema)?.clients.find(c => c.info?.kind === "app") : undefined;
  if (app !== undefined) await rex(["-C", app.client_id, "do", "session.select", `session_id=${session}`]);
  if (process.platform === "darwin") await exec(["/usr/bin/open", "-a", "Rex"]);
}

async function toggleTab(agent: string, found: Found): Promise<Result<Attach>> {
  if (found.block.window !== "") {
    const hidden = await api("session.detach_block", { session_id: found.session, block_id: found.block.id });
    return hidden.ok ? ok({ kind: "shown", note: `${agent} is hidden again and keeps running` }) : fail(`could not hide ${agent}: ${hidden.err}`);
  }
  const made = await rex(["window", "new", "-s", found.session, agent, "--keep-open", "--json", "--", "/bin/sh", "-c", "sleep 600"]);
  const opened = made.ok ? parse(made.out, RunSchema) : null;
  const holder = opened?.block_ids?.[0] ?? null;
  if (holder === null) return fail(`could not open a tab for ${agent}: ${made.ok ? "unexpected output" : made.err}`);
  const placed = await api("session.move_block", { session_id: found.session, block_id: found.block.id, anchor_block_id: holder, direction: "horizontal", side: "after" });
  await rex(["block", "close", holder]);
  if (!placed.ok) return fail(`could not open ${agent}: ${placed.err}`);
  const window = opened?.window_id;
  if (typeof window === "string") await rex(["focus", "-s", found.session, window]);
  return ok({ kind: "shown", note: `${agent} is open in its own Rex tab (open it again here to hide it; closing the tab stops it)` });
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
      const shared = await sharedBlocks(viewer.rexSession);
      if (shared === null) return null;
      for (const b of shared) { const agent = agentOf(conversation, b.label); if (b.live && agent !== null) names.add(agent); }
    }
    const sid = await sessionId(sessionName(conversation));
    if (sid.kind === "unknown") return null;
    if (sid.kind === "found") {
      const blocks = await sharedBlocks(sid.id);
      if (blocks === null) return null;
      for (const b of blocks) {
        const agent = agentOf(conversation, b.label);
        if (b.live && agent !== null) names.add(agent);
      }
      const legacy = await blocksOf(sid.id);
      if (legacy === null) return null;
      for (const b of legacy) if (b.live && agentBlock(b)) names.add(b.label);
    }
    return [...names];
  },
  async attach(conversation, label) {
    if (rexBinary() === null) return fail("Rex is not installed");
    const found = await findAgent(conversation, label);
    if (found === null) return fail(`${label} has no Rex window (it may have ended)`);
    if (found.block.label === sharedLabel(conversation, label)) {
      const toggled = await toggleTab(label, found);
      if (toggled.ok && !found.shared && found.block.window === "") await showInApp(found.session);
      return toggled;
    }
    await rex(["focus", "-s", found.session, found.block.window]);
    await showInApp(found.session);
    return ok({ kind: "shown", note: `showing ${label} in Rex` });
  },
  async stop(conversation, agent) {
    if (!rexUsed()) return;
    const viewer = await viewerSession(conversation);
    if (viewer?.rexSession != null) {
      for (const b of (await sharedBlocks(viewer.rexSession) ?? []).filter(x => x.label === sharedLabel(conversation, agent))) await rex(["block", "close", b.id]);
    }
    const sid = await sessionId(sessionName(conversation));
    if (sid.kind !== "found") return;
    for (const b of (await sharedBlocks(sid.id) ?? []).filter(x => x.label === sharedLabel(conversation, agent))) await rex(["block", "close", b.id]);
    const windows = new Set((await blocksOf(sid.id) ?? []).filter(b => b.label === agent && agentBlock(b)).map(b => b.window));
    for (const window of windows) await rex(["window", "close", "-s", sid.id, window]);
  },
};
