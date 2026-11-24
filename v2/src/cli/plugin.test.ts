import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths, loadConfig } from "../config";
import { createConversation } from "../core/conversations";
import { ensureBubble } from "../core/bubbles";
import { registerBuiltins, availablePlugins, loadForCheck } from "../core/plugins";
import { tempHome } from "../test/home";
import { runPlugin } from "./plugin";
import { pluginTemplate } from "./template";
const home = tempHome("plugin-cli");
async function cli(...args: string[]) {
  let output = "";
  const code = await runPlugin(
    args,
    (s) => {
      output += s;
    },
    async () => {
      throw new Error("unexpected read from stdin");
    },
    false,
  );
  return { code, output };
}
async function makePlugin(name: string) {
  const dir = join(paths.plugins, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.ts"), pluginTemplate(name)["index.ts"] ?? "");
  return dir;
}
test("an agent approves the exact local version and changes only its conversation's bubble", async () => {
  registerBuiltins([]);
  const a = await createConversation(home.path(), "a"),
    b = await createConversation(home.path(), "b");
  const ba = await ensureBubble(a.id),
    bb = await ensureBubble(b.id);
  if (!ba.ok || !bb.ok) throw new Error("fixture bubbles");
  const before = process.env.ORCA_CONVERSATION;
  process.env.ORCA_CONVERSATION = b.id;
  try {
    const dir = await makePlugin("probe");
    expect((await cli("enable", "probe")).code).toBe(3);
    expect((await cli("enable", "probe", "--yes", "--from", dir)).code).toBe(0);
    expect((await cli("show", "probe")).output).toContain("probe");
    expect((await cli("list", "--json")).output).toContain('"enabled":true');
    expect((await cli("list", "--bubble", ba.data.id, "--json")).output).toContain('"enabled":false');
    expect((await loadConfig()).plugins).not.toContain("probe");
    expect((await cli("config", "probe", "--set", "timeout", "4", "--global")).output).toBe('{"timeout":4}\n');
    expect((await cli("config", "probe", "--set", "timeout", "6")).output).toBe('{"timeout":6}\n');
    expect((await cli("config", "probe", "--unset", "timeout")).output).toBe('{"timeout":4}\n');
    expect((await cli("disable", "probe")).code).toBe(0);
    expect((await cli("inherit", "probe")).code).toBe(0);
    expect((await cli("list", "--json")).output).toContain('"override":null');
    expect((await cli("enable", "../bad", "--yes")).code).toBe(2);
  } finally {
    if (before === undefined) delete process.env.ORCA_CONVERSATION;
    else process.env.ORCA_CONVERSATION = before;
  }
});
test("built-in mirror is reported once and a trusted repository collision still surfaces", async () => {
  await makePlugin("mirror");
  const fixture = await loadForCheck(join(paths.plugins, "mirror"), "mirror");
  if (!fixture.ok) throw new Error(fixture.error);
  registerBuiltins([
    {
      name: "mirror",
      dir: "builtins/mirror",
      index: async () => ({ default: fixture.data.plugin }),
      ui: null,
      background: null,
    },
  ]);
  try {
    const repo = join(home.path(), "repo");
    const other = join(repo, ".orca2", "plugins", "mirror");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "index.ts"), "throw Error('shadow plugin should not execute')");
    const result = await availablePlugins(repo, true);
    expect(result.plugins.get("mirror")?.source).toBe("builtin");
    expect(result.problems.map((p) => p.dir)).toEqual([other]);
  } finally {
    registerBuiltins([]);
  }
});

test("enable groups new approvals and prints one confirmation for the requested plugins", async () => {
  const a = "brief-one", b = "brief-two", c = "brief-three";
  for (const name of [a, b, c]) await makePlugin(name);
  expect((await cli("enable", a, "--global", "--yes")).code).toBe(0);

  const prompts: string[] = [];
  let output = "";
  const args = ["enable", a, b, c, b, "--global"];
  const run = (allow: boolean) => runPlugin(args, line => { output += line; }, async question => {
    prompts.push(question);
    return allow;
  }, true);

  expect(await run(false)).toBe(1);
  expect((await loadConfig()).plugins).not.toContain(b);
  expect(output).toBe("Cancelled.\n");
  output = "";
  expect(await run(true)).toBe(0);
  const question = "Allow brief-two and brief-three to run with your permissions?";
  expect(prompts).toEqual([question, question]);
  expect(output).toBe("Enabled brief-one, brief-two, and brief-three globally.\n");
  const alreadyApproved = await cli(...args);
  expect(alreadyApproved).toEqual({ code: 0, output });
});

test("a batch validates its names and selected versions before changing enablement", async () => {
  const name = "brief-changed";
  const dir = await makePlugin(name);
  expect((await cli("enable", name, "missing-plugin", "--global", "--yes")).code).toBe(1);
  expect((await cli("enable", name, "brief-two", "--from", dir, "--yes")).code).toBe(2);
  expect(await runPlugin(["enable", name, "--global"], () => {}, async () => {
    await writeFile(join(dir, "note.txt"), "changed while waiting for approval");
    return true;
  }, true)).toBe(1);
  const config = await loadConfig();
  expect(config.plugins).not.toContain(name);
  expect(config.approved.some(pin => pin.startsWith(name+"@"))).toBe(false);
});
