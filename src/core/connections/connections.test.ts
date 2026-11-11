import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { attachDirectory, paths } from "../../config";
import { checkedConnection, connectionKey, listConnections, saveConnection } from "./config";
import { disconnectConnections, withConnection } from "./client";
import { loginConnection, oauthProvider } from "./auth";
import { manageConnections } from "./manage";
import { mcp } from "../tools/mcp";
import { connectionsCommand, type ConnectionsHost } from "../../tui/commands/connections";

let home: string, previous: string | undefined;
beforeEach(async () => { previous = process.env.ORCA_HOME; home = await mkdtemp(join(tmpdir(), "orca-mcp-")); process.env.ORCA_HOME = home; });
afterEach(async () => { await disconnectConnections(); process.env.ORCA_HOME = previous; await rm(home, { recursive: true, force: true }); });
async function project(name = "orch-test") { await mkdir(paths.project(name), { recursive: true }); attachDirectory(paths.memory, name, home, "", {}); return name; }
const script = `import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line', async line=> { const r=JSON.parse(line); if(r.id===undefined)return;
let result = r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{},resources:{},prompts:{}},serverInfo:{name:'fixture',version:'1'}}:
r.method==='tools/list'?{tools:[{name:'echo',description:'Echo exact text',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}:
r.method==='tools/call'?{content:[{type:'text',text:r.params.arguments.text??String(process.pid)}]}:
r.method==='resources/list'?{resources:[]}:{prompts:[]};
if(r.params?.name==='slow')await new Promise(resolve=>setTimeout(resolve,10000));
console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result})); });`;
function local() { saveConnection({ name: "local", transport: "stdio", enabled: true, command: process.execPath, args: ["-e", script] }); }

test("project overrides are shared across directory conversations; disabled overrides suppress globals", async () => {
  const p = await project(), sibling = await project("orch-sibling");
  local(); saveConnection({ ...listConnections()[0], enabled: false }, p);
  expect(listConnections()[0]!.enabled).toBe(true);
  expect(listConnections(sibling)[0]!.enabled).toBe(false);
  await expect(withConnection(p, "local", home, undefined, async () => true)).rejects.toThrow("disabled");
});
test("configuration rejects embedded credentials and preserves argument whitespace", async () => {
  expect(() => checkedConnection({ name: "bad", transport: "http", enabled: true, url: "https://user:secret@example.com" })).toThrow();
  expect(() => checkedConnection({ name: "bad", transport: "http", enabled: true, url: "http://example.com" })).toThrow();
  await manageConnections('save global {"name":"x","transport":"stdio","enabled":true,"command":"echo","args":["a  b"]}');
  expect(listConnections()[0]!.args).toEqual(["a  b"]);
});
test("real stdio discovery and calls reuse one process; explicit close terminates it", async () => {
  local();
  const pid = await withConnection(undefined, "local", home, undefined, async (client, options) => {
    expect((await client.listTools({}, options)).tools[0]!.name).toBe("echo");
    return Number(((await client.callTool({ name: "echo", arguments: {} }, undefined, options)).content as any)[0].text);
  });
  const next = await withConnection(undefined, "local", home, undefined, async (client, options) => Number(((await client.callTool({ name: "echo", arguments: {} }, undefined, options)).content as any)[0].text));
  expect(next).toBe(pid);
  await disconnectConnections();
  expect(() => process.kill(pid, 0)).toThrow();
});
test("cancellation closes the local server without retrying a call", async () => {
  local(); const abort = new AbortController();
  const call = withConnection(undefined, "local", home, abort.signal, async (client, options) => {
    setTimeout(() => abort.abort(new Error("stopped")), 30);
    return client.callTool({ name: "slow", arguments: {} }, undefined, options);
  });
  await expect(call).rejects.toThrow();
});
test("agent gateway discovers schemas on demand and invokes the enabled server", async () => {
  const p = await project(); local();
  const ctx = { project: p, role: "orchestrator" as const, cwd: home };
  expect(String(await mcp.run({ action: "tools", server: "local" }, ctx))).toContain("echo");
  expect(String(await mcp.run({ action: "schema", server: "local", name: "echo" }, ctx))).toContain("inputSchema");
  const result = await mcp.run({ action: "call", server: "local", name: "echo", arguments: { text: "working" } }, ctx);
  expect(JSON.stringify(result)).toContain("working");
});
test("HTTP transport sends local bearer credentials but definitions contain no tokens", async () => {
  const authorization: (string | null)[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    authorization.push(req.headers.get("authorization"));
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const r = await req.json() as any;
    if (r.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: r.id, result: r.method === "initialize" ? { protocolVersion: r.params.protocolVersion, capabilities: {}, serverInfo: { name: "http", version: "1" } } : {} });
  }});
  process.env.ORCA_TEST_MCP_TOKEN = "test-private-token";
  try {
    saveConnection({ name: "remote", transport: "http", enabled: true, url: `http://127.0.0.1:${server.port}/mcp`, tokenEnv: "ORCA_TEST_MCP_TOKEN" });
    expect(await manageConnections("test remote")).toContain("connected");
    expect(authorization).toContain("Bearer test-private-token");
    expect(JSON.stringify(listConnections())).not.toContain("test-private-token");
  } finally { await disconnectConnections(); server.stop(true); delete process.env.ORCA_TEST_MCP_TOKEN; }
});
test("connections menu adds an editable definition without launching or authorizing anything", async () => {
  let draft = ""; const menus: { title: string; choices: any[]; pick: (value: any) => any }[] = [];
  const host: ConnectionsHost = { current: () => true, note() {}, draft: text => { draft = text; }, open: (title, choices, pick) => { menus.push({ title, choices, pick }); } };
  await connectionsCommand("", host);
  await menus[0]!.pick(null); await menus[1]!.pick("http");
  expect(draft).toContain("/connections save global"); expect(listConnections()).toHaveLength(0);
});
test("OAuth uses PKCE and validates state; credentials remain local and logout removes them", async () => {
  let challenge = "", tokenRequests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const origin = new URL(req.url).origin, path = new URL(req.url).pathname;
    if (path.includes("oauth-protected-resource")) return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (path.includes("oauth-authorization-server")) return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (path === "/register") return Response.json({ ...await req.json() as object, client_id: "orca-test" });
    if (path === "/token") { const form = new URLSearchParams(await req.text()); expect(form.get("code")).toBe("test-code"); expect(form.get("code_verifier")).toBeTruthy(); tokenRequests++; return Response.json({ access_token: "private-oauth-token", token_type: "Bearer", refresh_token: "private-refresh" }); }
    return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
  }});
  try {
    saveConnection({ name: "oauth", transport: "http", enabled: true, url: `http://127.0.0.1:${server.port}/mcp`, oauth: true });
    const c = listConnections()[0]!;
    let callback!: Promise<void>;
    await loginConnection(c, url => { callback = (async () => {
      const u = new URL(url); challenge = u.searchParams.get("code_challenge")!;
      const target = new URL(u.searchParams.get("redirect_uri")!); target.searchParams.set("code", "test-code"); target.searchParams.set("state", "wrong");
      expect((await fetch(target)).status).toBe(400);
      target.searchParams.set("state", u.searchParams.get("state")!); expect((await fetch(target)).status).toBe(200);
    })(); });
    await callback; expect(challenge).toBeTruthy(); expect(tokenRequests).toBe(1);
    expect((await (await oauthProvider(c)).tokens())?.access_token).toBe("private-oauth-token");
    expect(JSON.stringify(listConnections())).not.toContain("private-oauth-token");
    expect(connectionKey({ ...c, url: c.url + "/other" })).not.toBe(connectionKey(c));
    await manageConnections("logout oauth"); expect(await (await oauthProvider(c)).tokens()).toBeUndefined();
  } finally { server.stop(true); }
});
