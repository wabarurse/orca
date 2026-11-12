import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessEngine, installedApp, legacy, stateRoot, siblingWorktreeRoots } from "./legacy";

const roots: string[] = [];
function fixture() { const path = mkdtempSync(join(tmpdir(), "orca-rename-")); roots.push(path); return path; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("new installs use orca; an app-only checkout cannot hide existing logins and chats", () => {
  const home = fixture(), old = join(home, legacy.stateDirectory), current = join(home, ".orca");
  expect(stateRoot(home, {})).toBe(current);
  mkdirSync(join(old, "auth"), { recursive: true });
  writeFileSync(join(old, "config.toml"), 'model = "saved-model"');
  mkdirSync(join(current, "app"), { recursive: true });
  expect(stateRoot(home, {})).toBe(old);
  expect(stateRoot(home, { [legacy.homeVariable]: "/old-custom" })).toBe("/old-custom");
  expect(stateRoot(home, { ORCA_HOME: "/new-custom", [legacy.homeVariable]: "/old-custom" })).toBe("/new-custom");
  mkdirSync(join(current, "projects"));
  expect(stateRoot(home, {})).toBe(current);
  expect(() => installedApp(home)).toThrow("offline layout migration");
  rmSync(join(current, "app"), { recursive: true });
  mkdirSync(join(old, ".runtime", "app"), { recursive: true });
  expect(installedApp(home)).toBe(join(old, ".runtime", "app"));
});

test("existing worker checkout paths beside the checkout remain known; none is invented", () => {
  const home = fixture(), checkout = join(home, "repo");
  const id = crypto.randomUUID(), old = join(`${checkout}${legacy.worktreeSuffix}`, id), sibling = join(`${checkout}.orca-worktrees`, id);
  expect(siblingWorktreeRoots(checkout, id)).toEqual([]);
  mkdirSync(sibling, { recursive: true });
  expect(siblingWorktreeRoots(checkout, id)).toEqual([sibling]);
  mkdirSync(old, { recursive: true });
  expect(siblingWorktreeRoots(checkout, id)).toEqual([old, sibling]);
  expect(harnessEngine(legacy.engine)).toBe(true);
  expect(harnessEngine("orca")).toBe(true);
  expect(harnessEngine("codex")).toBe(false);
});
