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
const RESTART = "New agents load this now; a running chat keeps the plugin code, watchers and tabs it loaded until you /stop it (or orca2 stop --conversation <id>) and reopen orca2.\n";
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
  expect(output).toBe("Enabled brief-one, brief-two, and brief-three globally.\n" + RESTART);
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

test("update re-approves a changed plugin and leaves every scope's on/off alone", async () => {
  registerBuiltins([]);
  const name = "brief-update";
  const dir = await makePlugin(name);
  expect((await cli("enable", name, "--global", "--yes")).code).toBe(0);
  const conversation = await createConversation(home.path(), "upd");
  const bubble = await ensureBubble(conversation.id);
  if (!bubble.ok) throw new Error(bubble.error);
  expect((await cli("disable", name, "--bubble", bubble.data.id)).code).toBe(0);
  const before = await loadConfig();
  expect((await cli("update", name)).output).toBe(`${name} is up to date\n`);
  await writeFile(join(dir, "note.txt"), "edited in place");
  expect((await availablePlugins(null, false)).problems.find(p => p.name === name)?.problem).toBe(`not approved (changed): run orca2 plugin update ${name}`);
  expect(await cli("update", name)).toEqual({ code: 3, output: `Approval needed for ${name}. Use --yes to approve.\n` });
  expect((await cli("update", name, "--yes")).output).toBe(`Updated ${name}.\n${RESTART}`);
  const after = await loadConfig();
  expect(after.plugins).toEqual(before.plugins);
  expect(after.approved.filter(pin => pin.startsWith(name + "@"))).toHaveLength(1);
  expect(after.approved).not.toEqual(before.approved);
  expect((await availablePlugins(null, false)).plugins.has(name)).toBe(true);
  const listed = (await cli("list", "--bubble", bubble.data.id, "--json")).output;
  expect(listed).toContain(`"name":"${name}","enabled":false,"override":"off"`);
  expect((await cli("list", "--global", "--json")).output).toContain(`"name":"${name}","enabled":true,"override":null`);
  expect((await cli("update", name, "--yes")).output).toBe(`${name} is up to date\n`);
});

test("update --from copies the folder and refuses new, built-in and misused names", async () => {
  registerBuiltins([]);
  const name = "brief-copied";
  await makePlugin(name);
  expect((await cli("enable", name, "--global", "--yes")).code).toBe(0);
  const work = join(home.path(), "work", name);
  await mkdir(work, { recursive: true });
  await writeFile(join(work, "index.ts"), pluginTemplate(name)["index.ts"] ?? "");
  await writeFile(join(work, "extra.txt"), "new file");
  expect((await cli("update", name, "--from", work, "--yes")).output).toBe(`Updated ${name}.\n${RESTART}`);
  expect(await Bun.file(join(paths.plugins, name, "extra.txt")).text()).toBe("new file");
  expect((await cli("update", name, "--from", work, "--yes")).output).toBe(`${name} is up to date\n`);
  expect((await loadConfig()).plugins).toContain(name);

  const fresh = await cli("update", "brief-never", "--yes");
  expect(fresh.code).toBe(1);
  expect(fresh.output).toContain("orca2 plugin enable brief-never");
  const fixture = await loadForCheck(join(paths.plugins, name), name);
  if (!fixture.ok) throw new Error(fixture.error);
  registerBuiltins([{ name: "core-one", dir: "builtins/core-one", index: async () => ({ default: fixture.data.plugin }), ui: null, background: null }]);
  try {
    expect(await cli("update", "core-one")).toEqual({ code: 1, output: "core-one is supplied by Orca and updates with orca2\n" });
  } finally { registerBuiltins([]); }
  expect((await cli("update", name, "brief-two", "--from", work)).code).toBe(2);
  expect((await cli("update", name, "--global")).code).toBe(2);
  expect((await cli("update", name, "--bubble")).code).toBe(2);
});

test("a never-approved plugin still points to enable", async () => {
  registerBuiltins([]);
  await makePlugin("brief-unseen");
  expect((await availablePlugins(null, false)).problems.find(p => p.name === "brief-unseen")?.problem).toBe("not approved (new): run orca2 plugin enable brief-unseen");
});
