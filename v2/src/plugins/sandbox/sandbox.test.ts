import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation } from "../../core/conversations";
import { item, present, toolContext } from "../../core/plugins/testing";
import plugin from "./index";
import { MAC_PROFILE, sandboxArgv } from "./sandbox";

const tool = item(plugin.tools, 0).tool;

test("argv per platform; no sandbox is a refusal, never a plain run", () => {
  const has = (bin: string) => `/usr/bin/${bin}`;
  expect(sandboxArgv({ os: "darwin", which: has }, "/s", "/w", "ls")).toEqual({ ok: true, data: ["/usr/bin/sandbox-exec", "-D", "SCRATCH=/s", "-p", MAC_PROFILE, "bash", "-c", "ls"] });
  const linux = sandboxArgv({ os: "linux", which: has }, "/s", "/w", "ls");
  expect(linux.ok ? linux.data.join(" ") : linux.error).toContain("--ro-bind / / --dev /dev --proc /proc --bind /s /s --chdir /w");
  expect(sandboxArgv({ os: "linux", which: () => null }, "/s", "/w", "ls")).toEqual({ ok: false, error: "bwrap (bubblewrap) is not installed; install it to use the sandbox" });
  expect(sandboxArgv({ os: "win32", which: has }, "/s", "/w", "ls").ok).toBe(false);
  expect(MAC_PROFILE).toContain("(deny file-write*)");
  expect(MAC_PROFILE).toContain('(subpath (param "SCRATCH"))');
});

test.skipIf(process.platform !== "darwin" || Bun.which("sandbox-exec") === null)("a real run cannot write the working directory but can write scratch; clean removes it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orca2-sandbox-cwd-"));
  await Bun.write(join(cwd, "input.txt"), "readable");
  const conversation = await createConversation(cwd, "t");
  const ctx = toolContext(conversation.id, cwd, { agent: "worker-a", role: "worker", branch: "a" });
  const out = String(await tool.run({ action: "run", command: "cat input.txt; echo; echo x > here.txt; echo y > \"$ORCA_SCRATCH/out.txt\" && echo wrote" }, ctx));
  expect(out).toContain("readable");
  expect(out).toContain("Operation not permitted");
  expect(out).toContain("wrote");
  expect(await Bun.file(join(cwd, "here.txt")).exists()).toBe(false);
  const match = present(/\[sandbox (\w+): exit 0; scratch (.+)\]/.exec(out), "sandbox line");
  const id = present(match[1], "sandbox id"), scratch = present(match[2], "scratch");
  expect(await Bun.file(join(scratch, "out.txt")).text()).toBe("y\n");
  expect(await tool.run({ action: "clean", id }, ctx)).toBe(`removed ${id}`);
  expect(await Bun.file(join(scratch, "out.txt")).exists()).toBe(false);
  expect(await tool.run({ action: "clean", id: "../.." }, ctx)).toBe("refused: no sandbox ../..");
});
