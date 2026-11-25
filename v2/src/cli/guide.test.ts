import { expect, test } from "bun:test";
import { join } from "node:path";
import { ensureBuiltinSkills } from "../core/builtin-skills";
import { createConversation } from "../core/conversations";
import { SLASH_COMMANDS } from "../core/slash-commands";
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

test("the guide lists every TUI slash command as user-only, with its CLI equivalent", async () => {
  const conversation = await createConversation(process.cwd(), null);
  const guide = await agentGuide(conversation.id);
  expect(guide).toContain("user-only");
  for (const c of SLASH_COMMANDS) expect(guide).toContain(`  ${c.usage}: ${c.description}`);
  for (const [name, cli] of [["stop", "orca2 stop"], ["rename", "orca2 rename"], ["trust", "orca2 trust"], ["login", "orca2 login"], ["accounts", "orca2 accounts"]] as const) {
    expect(SLASH_COMMANDS.find(c => c.name === name)?.cli ?? "").toStartWith(cli);
  }
  expect(await agentGuide(null)).toContain("$ORCA_CONVERSATION");
});

test("the TUI handles exactly the slash commands of the shared table", async () => {
  const source = await Bun.file(join(import.meta.dir, "../tui/app.ts")).text();
  const body = source.slice(source.indexOf("private async command(text: string)"), source.indexOf("const own = this.uis"));
  const handled = new Set([...body.matchAll(/name === "([a-z]+)"/g)].map(m => m[1]));
  handled.delete("exit");
  expect([...handled].sort()).toEqual(SLASH_COMMANDS.map(c => c.name).sort());
});
