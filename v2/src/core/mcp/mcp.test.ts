import { afterEach, beforeEach, expect, test } from "bun:test";
import { noLinks } from "../plugins/testing";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths, type Result } from "../../config";
import { readServers, usableServer, serverKey, loginKey } from "./config";
import { connected, disconnectServers, withServer } from "./client";
import { loginServer, logoutServer, oauthProvider, signedIn } from "./auth";
import { mcp } from "../tools/mcp";
import type { ToolContext } from "../tools/registry";
import { runMcp } from "../../cli/mcp";

let home: string, previous: string | undefined;
beforeEach(async () => { previous = process.env.ORCA2_HOME; home = await mkdtemp(join(tmpdir(), "orca-mcp-")); process.env.ORCA2_HOME = home; });
afterEach(async () => {
  await disconnectServers();
  if (previous === undefined) delete process.env.ORCA2_HOME; else process.env.ORCA2_HOME = previous;
  delete process.env.ORCA_TEST_MCP_TOKEN;
  await rm(home, { recursive: true, force: true });
});
const write = (mcpServers: Record<string, unknown>) => writeFileSync(paths.mcp, JSON.stringify({ mcpServers }, null, 2));
const script = `import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line', async line=> { const r=JSON.parse(line); if(r.id===undefined)return;
if(r.method==='tools/call'&&r.params.name==='nope'){console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32602,message:'Unknown tool: nope'}}));return;}
let result = r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{},resources:{},prompts:{}},serverInfo:{name:'fixture',version:'1'}}:
r.method==='tools/list'?{tools:[{name:'echo',description:'Echo exact text',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}:
r.method==='tools/call'?{content:[{type:'text',text:r.params.arguments.text??String(process.pid)}]}:
r.method==='resources/list'?{resources:[]}:{prompts:[]};
if(r.params?.name==='slow')await new Promise(resolve=>setTimeout(resolve,10000));
console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result})); });`;
const local = (extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: ["-e", script], ...extra });
const failure = async <T>(pending: Promise<Result<T>>): Promise<string> => { const result = await pending; return result.ok ? "" : result.error; };
const refusal = (name: string): string => { const result = usableServer(name); return result.ok ? "" : result.error; };
const usable = (name: string) => { const result = usableServer(name); if (!result.ok) throw new Error(result.error); return result.data; };
const pid = async (): Promise<number> => {
  const result = await withServer("local", home, undefined, async (client, options) => Number(z.array(z.looseObject({ text: z.string() })).parse((await client.callTool({ name: "echo", arguments: {} }, undefined, options)).content)[0]?.text));
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
const ctxFor = (role: "orchestrator" | "worker"): ToolContext => ({ conversation: "c-00000000", agent: role, role, branch: null, cwd: home, data: home, trusted: false, pluginSkills: [], guard: [],
  callId: "call", signal: new AbortController().signal, model: "m", provider: { name: "anthropic", complete: async () => { throw new Error("no"); }, models: async () => [] }, settings: null,
  runtime: { spawn: async () => { throw new Error("no"); }, agents: async () => [], stop: async () => "", show: async () => "", confirm: async () => false }, links: noLinks });
const alive = (id: number) => { try { process.kill(id, 0); return true; } catch { return false; } };

test("mcp.json: a command or a url per server, ${VAR} from the environment, and one bad entry never hides the others", () => {
  expect(readServers()).toEqual({ path: paths.mcp, entries: [] });
  process.env.ORCA_TEST_MCP_TOKEN = "private-token";
  write({
    files: { command: "npx", args: ["-y", "a  b"], env: { TOKEN: "${ORCA_TEST_MCP_TOKEN}", PLAIN: "literal" }, timeout: 5 },
    linear: { url: "https://mcp.linear.app/mcp" },
    api: { url: "http://localhost:8080/mcp", headers: { Authorization: "Bearer ${ORCA_TEST_MCP_TOKEN}" }, type: "http" },
    off: { command: "x", env: { A: "${ORCA_TEST_UNSET_VARIABLE}" }, disabled: true },
    both: { command: "x", url: "https://example.com" },
    neither: {},
    typo: { command: "x", arg: ["-y"] },
    plain: { url: "http://example.com/mcp" },
    secret: { url: "https://user:pass@example.com/mcp" },
    old: { url: "https://example.com/sse", type: "sse" },
    unset: { command: "x", env: { A: "${ORCA_TEST_UNSET_VARIABLE}" } },
    "bad name": { command: "x" },
  });
  const { entries, problem } = readServers(), by = Object.fromEntries(entries.map(e => [e.name, e]));
  expect(problem).toBeUndefined();
  expect(entries.map(e => e.name)).toEqual(["files", "linear", "api", "off", "both", "neither", "typo", "plain", "secret", "old", "unset", "bad name"]);
  expect(by.files?.server).toEqual({ name: "files", command: "npx", args: ["-y", "a  b"], env: { TOKEN: "private-token", PLAIN: "literal" }, headers: {}, timeoutMs: 5000 });
  expect(by.linear?.server).toEqual({ name: "linear", url: "https://mcp.linear.app/mcp", args: [], env: {}, headers: {}, timeoutMs: 60000 });
  expect(by.api?.server?.headers).toEqual({ Authorization: "Bearer private-token" });
  expect(by.off).toEqual({ name: "off", disabled: true });
  expect(by.both?.problem).toContain("either a command");
  expect(by.neither?.problem).toContain("either a command");
  expect(by.typo?.problem).toContain('unknown setting "arg"');
  expect(by.plain?.problem).toContain("https");
  expect(by.secret?.problem).toContain("headers");
  expect(by.old?.problem).toContain("SSE");
  expect(by.unset?.problem).toContain("${ORCA_TEST_UNSET_VARIABLE}");
  expect(by["bad name"]?.problem).toContain("letters, digits");
  expect(refusal("off")).toContain(`disabled in ${paths.mcp}`);
  expect(refusal("typo")).toContain("unknown setting");
  expect(refusal("missing")).toContain("it has: files, linear");
  writeFileSync(paths.mcp, "{ not json");
  expect(readServers().problem).toContain("is not valid JSON");
  expect(refusal("files")).toContain("is not valid JSON");
  writeFileSync(paths.mcp, JSON.stringify({ servers: {} }));
  expect(readServers().problem).toContain('"mcpServers"');
});

test("a local server keeps running between calls and after a refused request; an edit or a disconnect ends it", async () => {
  write({ local: local() });
  const first = await pid();
  expect(await pid()).toBe(first);
  expect(connected("local")).toBe(true);
  expect(await failure(withServer("local", home, undefined, (client, options) => client.callTool({ name: "nope", arguments: {} }, undefined, options)))).toContain("Unknown tool");
  await expect(mcp.run({ action: "schema", server: "local", name: "absent" }, ctxFor("orchestrator"))).rejects.toThrow("no tool named absent");
  await expect(mcp.run({ action: "call", server: "local" }, ctxFor("orchestrator"))).rejects.toThrow("name is required");
  expect(await pid()).toBe(first);
  write({ local: local({ env: { CHANGED: "1" } }) });
  const second = await pid();
  expect(second).not.toBe(first);
  await Bun.sleep(50); expect(alive(first)).toBe(false);
  write({ local: local({ disabled: true }) });
  await expect(pid()).rejects.toThrow("disabled");
  await disconnectServers();
  await Bun.sleep(50); expect(alive(second)).toBe(false); expect(connected("local")).toBe(false);
});

test("a server that cannot start says what it printed; a cancelled call closes the connection without a retry", async () => {
  write({ broken: { command: process.execPath, args: ["-e", "console.error('missing API key: set EXAMPLE_KEY'); process.exit(3)"] }, local: local() });
  const broken = await failure(withServer("broken", home, undefined, async () => true));
  expect(broken).toContain("could not connect to MCP server broken");
  expect(broken).toContain("missing API key: set EXAMPLE_KEY");
  expect(connected("broken")).toBe(false);

  const abort = new AbortController();
  const call = withServer("local", home, abort.signal, async (client, options) => {
    setTimeout(() => abort.abort(new Error("stopped")), 30);
    return client.callTool({ name: "slow", arguments: {} }, undefined, options);
  });
  expect((await call).ok).toBe(false);
  expect(connected("local")).toBe(false);
});

test("the agent's mcp tool lists servers, finds schemas on demand and calls a tool", async () => {
  write({ local: local(), off: { url: "https://example.com/mcp", disabled: true }, wrong: {} });
  const ctx = ctxFor("worker");
  expect(JSON.parse(String(await mcp.run({ action: "servers" }, ctx)))).toEqual({ file: paths.mcp, servers: [
    { name: "local", state: "ready", kind: "local command" }, { name: "off", state: "disabled" },
    { name: "wrong", state: "unusable: needs either a command (a local program) or a url, not both" }] });
  expect(String(await mcp.run({ action: "tools", server: "local" }, ctx))).toContain("echo");
  expect(String(await mcp.run({ action: "tools", server: "local", search: "nothing-like-it" }, ctx))).not.toContain("echo");
  expect(String(await mcp.run({ action: "schema", server: "local", name: "echo" }, ctx))).toContain("inputSchema");
  expect(JSON.stringify(await mcp.run({ action: "call", server: "local", name: "echo", arguments: { text: "working" } }, ctx))).toContain("working");
  await expect(mcp.run({ action: "tools", server: "off" }, ctx)).rejects.toThrow("disabled");
});

test("a url server gets its headers, with the token taken from the environment and never written to the file", async () => {
  const authorization: (string | null)[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    authorization.push(req.headers.get("authorization"));
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const r = z.object({ id: z.number().optional(), method: z.string(), params: z.looseObject({ protocolVersion: z.string().optional() }).optional() }).parse(await req.json());
    if (r.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: r.id, result: r.method === "initialize" ? { protocolVersion: r.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http", version: "1" } } : { tools: [] } });
  }});
  process.env.ORCA_TEST_MCP_TOKEN = "test-private-token";
  try {
    write({ remote: { url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: "Bearer ${ORCA_TEST_MCP_TOKEN}" } } });
    const lines: string[] = [];
    await runMcp(["test"], line => lines.push(line));
    expect(lines.join("\n")).toContain("remote");
    expect(lines.join("\n")).toContain("connected, 0 tools");
    expect(authorization).toContain("Bearer test-private-token");
    expect(readFileSync(paths.mcp, "utf8")).not.toContain("test-private-token");
  } finally { await server.stop(true); }
});

test("orca mcp creates the file to edit, lists each server's state, and reports a failing one without stopping", async () => {
  const lines: string[] = [], out = (line: string) => lines.push(line);
  await runMcp([], out);
  expect(JSON.parse(readFileSync(paths.mcp, "utf8"))).toEqual({ mcpServers: {} });
  expect(lines[0]).toBe(`MCP servers in ${paths.mcp}`);
  expect(lines.join("\n")).toContain("none yet");
  write({ local: local(), off: { command: "x", disabled: true }, wrong: { url: "ftp://example.com" } });
  lines.length = 0; await runMcp(["list"], out);
  const listed = lines.join("\n");
  expect(listed).toMatch(/local\s+ready/); expect(listed).toMatch(/off\s+disabled/); expect(listed).toMatch(/wrong\s+not usable: url must be https/);
  lines.length = 0; await runMcp(["test"], out);
  expect(lines.join("\n")).toMatch(/local\s+connected, 1 tool: echo/);
  expect(lines.join("\n")).toMatch(/wrong\s+failed: MCP server wrong/);
  expect(lines.join("\n")).not.toContain("off");
  expect(connected("local")).toBe(false);
  lines.length = 0; expect(await runMcp(["save"], out)).toBe(2);
  expect(lines.join("\n")).toContain("usage:");
  lines.length = 0; expect(await runMcp(["login", "local"], out)).toBe(1);
  expect(lines.join("\n")).toContain("only a url server has a sign-in");
});

test("sign-in uses PKCE and checks state; tokens stay out of mcp.json, survive a header edit and go on logout", async () => {
  let challenge = "", tokenRequests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const origin = new URL(req.url).origin, path = new URL(req.url).pathname;
    if (path.includes("oauth-protected-resource")) return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (path.includes("oauth-authorization-server")) return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"] });
    if (path === "/register") return Response.json({ ...z.record(z.string(), z.unknown()).parse(await req.json()), client_id: "orca-test" });
    if (path === "/token") { const form = new URLSearchParams(await req.text()); expect(form.get("code")).toBe("test-code"); expect(form.get("code_verifier")).toBeTruthy(); tokenRequests++; return Response.json({ access_token: "private-oauth-token", token_type: "Bearer", refresh_token: "private-refresh" }); }
    return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
  }});
  try {
    write({ oauth: { url: `http://127.0.0.1:${server.port}/mcp` } });
    const s = usable("oauth");
    expect(await failure(withServer("oauth", home, undefined, async () => true))).toContain("orca2 mcp login oauth");
    let callback: Promise<void> = Promise.resolve();
    const signedInResult = await loginServer(s, url => { callback = (async () => {
      const u = new URL(url); challenge = u.searchParams.get("code_challenge") ?? "";
      const target = new URL(u.searchParams.get("redirect_uri") ?? ""); target.searchParams.set("code", "test-code"); target.searchParams.set("state", "wrong");
      expect((await fetch(target)).status).toBe(400);
      target.searchParams.set("state", u.searchParams.get("state") ?? ""); expect((await fetch(target)).status).toBe(200);
    })(); });
    expect(signedInResult).toEqual({ ok: true, data: null });
    await callback; expect(challenge).toBeTruthy(); expect(tokenRequests).toBe(1);
    expect(await signedIn(s)).toBe(true);
    expect((await oauthProvider(s).tokens())?.access_token).toBe("private-oauth-token");
    expect(readFileSync(paths.mcp, "utf8")).not.toContain("private-oauth-token");
    expect(existsSync(join(paths.runtime, "mcp-auth", `${loginKey(s)}.json`))).toBe(true);
    expect(serverKey({ ...s, timeoutMs: 1 })).toBe(serverKey(s));
    expect(serverKey({ ...s, headers: { X: "1" } })).not.toBe(serverKey(s));
    const edited: typeof s = { ...s, headers: { X: "1" } };
    expect(loginKey(edited)).toBe(loginKey(s));
    expect(loginKey({ ...s, url: s.url + "/other" })).not.toBe(loginKey(s));
    await logoutServer(s); expect(await signedIn(s)).toBe(false);
  } finally { await server.stop(true); }
});
