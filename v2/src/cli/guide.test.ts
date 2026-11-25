import { expect, test } from "bun:test";
import { join } from "node:path";
import { ensureBuiltinSkills } from "../core/builtin-skills";
import { createConversation } from "../core/conversations";
import { COMMANDS, commandUsage } from "../core/commands";
import { agentGuide, USAGE } from "./guide";
import { main } from "./main";
import { MCP_USAGE } from "./mcp";
import { PLUGIN_USAGE } from "./plugin";

async function run(argv: string[]): Promise<{ code: number; text: string }> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => { chunks.push(String(chunk)); return true; };
  try { return { code: await main(argv), text: chunks.join("") }; } finally { process.stdout.write = write; }
}

test("orca2 skill prints every usage line of orca2 help, plugin help and the mcp usage", async () => {
  const guide = await run(["skill"]);
  const help = await run(["help"]);
  expect(guide.code).toBe(0);
  expect(guide.text).toBe(await agentGuide(process.env.ORCA_CONVERSATION ?? null));
  const lines = [...help.text.split("\n"), ...PLUGIN_USAGE.split("\n"), ...MCP_USAGE.split("\n")].map(l => l.trim()).filter(l => l.length > 0 && l !== "usage:");
  expect(lines.length).toBeGreaterThan(20);
  for (const line of lines) expect(guide.text).toContain(line);
  expect(USAGE).toContain("orca2 skill");
});

test("ensureBuiltinSkills installs the thin orca2 skill that runs orca2 skill", async () => {
  const dirs = await ensureBuiltinSkills();
  const dir = dirs.find(d => d.endsWith(join("skills", "orca2")));
  expect(dir).toBeDefined();
  const text = await Bun.file(join(dir ?? "", "SKILL.md")).text();
  expect(text).toStartWith("---\nname: orca2\n");
  expect(text).toContain("Run `orca2 skill`");
  expect(text).toContain("orca2 help");
  expect(dirs.some(d => d.endsWith(join("skills", "orca-plugin")))).toBe(true);
});

test("the guide and help list every command of the shared table: runnable ones as CLI commands, the rest as TUI-only", async () => {
  const conversation = await createConversation(process.cwd(), null);
  const guide = await agentGuide(conversation.id);
  for (const c of COMMANDS) {
    if (c.run === null) expect(guide).toContain(`  /${c.name}: ${c.description}`);
    else { expect(USAGE).toContain(commandUsage(c)); expect(guide).toContain(commandUsage(c)); }
  }
  for (const name of ["model", "effort", "fast", "mux", "compact", "accounts", "stop", "rename", "trust", "login"]) expect(COMMANDS.find(c => c.name === name)?.run ?? null).not.toBeNull();
  for (const name of ["close", "quit", "help", "plugins"]) expect(COMMANDS.some(c => c.name === name && c.run === null)).toBe(true);
  expect(await agentGuide(null)).toContain("inside a conversation");
});

test("the TUI handles exactly the TUI-only commands itself and sends the rest to the table", async () => {
  const source = await Bun.file(join(import.meta.dir, "../tui/app.ts")).text();
  const body = source.slice(source.indexOf("private async command(text: string)"), source.indexOf("const own = this.uis"));
  const handled = new Set([...body.matchAll(/name === "([a-z]+)"/g)].map(m => m[1]));
  handled.delete("exit");
  expect([...handled].sort()).toEqual(COMMANDS.filter(c => c.run === null).map(c => c.name).sort());
  expect(body).toContain("coreCommand(name)");
});
