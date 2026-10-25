import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installBinary } from "./install";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orca-install-"))); roots.push(root);
  const home = join(root, "ho'me with spaces"), source = join(root, "compiled");
  const bin = join(home, ".local", "bin"), target = join(bin, "orca");
  await mkdir(bin, { recursive: true });
  await writeFile(source, "fixture executable", { mode: 0o755 });
  return { root, home, source, bin, target };
}

test("install and atomic owned upgrade preserve state, unrelated files and an open old executable", async () => {
  const { home, source, bin, target } = await fixture();
  await mkdir(join(home, ".orca", "auth"), { recursive: true });
  const saved = join(home, ".orca", "auth", "keep");
  await writeFile(saved, "private fixture");
  await writeFile(join(home, ".zshrc"), "do not edit");
  await writeFile(join(bin, "other"), "unrelated");
  expect(await installBinary(source, home)).toBe(target);
  const { open } = await import("node:fs/promises");
  const old = await open(target, "r");
  try {
    await writeFile(source, "new executable");
    expect(await installBinary(source, home)).toBe(target);
    expect(await old.readFile("utf8")).toBe("fixture executable");
    expect(await readFile(target, "utf8")).toBe("new executable");
  } finally { await old.close(); }
  expect(await readFile(saved, "utf8")).toBe("private fixture");
  expect(await readFile(join(home, ".zshrc"), "utf8")).toBe("do not edit");
  expect(await readFile(join(bin, "other"), "utf8")).toBe("unrelated");
  expect((await readdir(bin)).sort()).toEqual([".orca-install.json", "orca", "other"]);
});

test("unowned executable, even one named orca, is never overwritten", async () => {
  const { home, source, target } = await fixture();
  await writeFile(target, "unrelated");
  await expect(installBinary(source, home)).rejects.toThrow("unowned");
  expect(await readFile(target, "utf8")).toBe("unrelated");
});

for (const location of ["orca", ".orca-install.json", ".orca-install.lock"]) {
  test(`refuses a destination symlink at ${location}, including dangling links`, async () => {
    const { home, source, bin, root } = await fixture();
    const outside = join(root, "absent");
    await symlink(outside, join(bin, location));
    await expect(installBinary(source, home)).rejects.toThrow();
    expect(await Bun.file(outside).exists()).toBe(false);
  });
}
for (const location of [".local", ".local/bin"]) {
  test(`refuses symlinked parent ${location} without writing through it`, async () => {
    const { home, source, root } = await fixture();
    const outside = join(root, "outside"); await mkdir(outside);
    await rm(join(home, location), { recursive: true });
    await symlink(outside, join(home, location));
    await expect(installBinary(source, home)).rejects.toThrow("unsafe directory");
    expect(await readdir(outside)).toEqual([]);
  });
}

test("modified owned executable and malformed receipt fail closed", async () => {
  const { home, source, bin, target } = await fixture();
  await installBinary(source, home);
  await writeFile(target, "edited");
  await expect(installBinary(source, home)).rejects.toThrow("modified executable");
  expect(await readFile(target, "utf8")).toBe("edited");
  await writeFile(join(bin, ".orca-install.json"), "invalid");
  await expect(installBinary(source, home)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("edited");
});

test("existing lock is not removed; a missing or non-executable source preserves installed binary", async () => {
  const { home, source, bin, target } = await fixture();
  await installBinary(source, home);
  await chmod(source, 0o644);
  await expect(installBinary(source, home)).rejects.toThrow("not a compiled executable");
  await expect(installBinary(source + "-absent", home)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("fixture executable");
  const lock = join(bin, ".orca-install.lock");
  await mkdir(lock);
  await writeFile(join(lock, "keep"), "another installer");
  await expect(installBinary(source, home)).rejects.toThrow();
  expect(await readFile(join(lock, "keep"), "utf8")).toBe("another installer");
});

test("refuses directories and group/world-writable files rather than replacing them", async () => {
  const { home, source, target } = await fixture();
  await mkdir(target);
  await expect(installBinary(source, home)).rejects.toThrow("unsafe file");
  await rm(target, { recursive: true });
  await installBinary(source, home);
  await chmod(target, 0o777);
  await expect(installBinary(source, home)).rejects.toThrow("unsafe file");
});

test("script build failure leaves a previous installation untouched", async () => {
  const { root, home, source, target } = await fixture();
  await installBinary(source, home);
  const app = join(root, "app"); await mkdir(join(app, "scripts"), { recursive: true });
  await mkdir(join(app, "src"));
  await writeFile(join(app, "src", "installation.ts"), await readFile(join(import.meta.dir, "../src/installation.ts")));
  await writeFile(join(app, "scripts", "install.ts"), await readFile(join(import.meta.dir, "install.ts")));
  await writeFile(join(app, "package.json"), JSON.stringify({ scripts: { build: "exit 18" } }));
  const child = Bun.spawn([process.execPath, join(app, "scripts", "install.ts")], {
    cwd: root, env: { HOME: home, ORCA_HOME: join(root, "state"), PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe",
  });
  const err = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(err).toContain("build failed; installed executable was not changed");
  expect(await readFile(target, "utf8")).toBe("fixture executable");
});

test("failure of the final executable rename restores its receipt and preserves the old binary", async () => {
  const { home, source, bin, target } = await fixture();
  await installBinary(source, home);
  const receipt = await readFile(join(bin, ".orca-install.json"), "utf8");
  await writeFile(source, "new executable");
  const fs = await import("node:fs/promises");
  const { spyOn } = await import("bun:test");
  const original = fs.rename;
  const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === target) throw new Error("fixture final rename failure");
    return original(from, to);
  });
  try { await expect(installBinary(source, home)).rejects.toThrow("final rename failure"); }
  finally { rename.mockRestore(); }
  expect(await readFile(target, "utf8")).toBe("fixture executable");
  expect(await readFile(join(bin, ".orca-install.json"), "utf8")).toBe(receipt);
  await installBinary(source, home);
  expect(await readFile(target, "utf8")).toBe("new executable");
});
