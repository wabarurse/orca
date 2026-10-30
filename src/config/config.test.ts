import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, loadConfig, paths, saveConfig } from "./config";

let home: string;
const before = process.env.ORCA_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "orca-config-")); process.env.ORCA_HOME = home; });
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (before === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = before;
});

test("legacy orchestrator token targets cannot override the half-window policy", async () => {
  await Bun.write(paths.config, 'orchestratorContextTokens = 32000\nmodel = "claude-opus-5-5"\n');
  expect(await loadConfig()).not.toHaveProperty("orchestratorContextTokens");
  await saveConfig({ compact: true });
  expect(await Bun.file(paths.config).text()).not.toContain("orchestratorContextTokens");
  expect((await loadConfig()).model).toBe("claude-opus-5-5");
});

test("efficiency defaults are enabled and overrides remain bounded", async () => {
  expect((await loadConfig()).anthropicPromptCache).toBe(true);
  expect((await loadConfig()).toolConcurrency).toBe(4);
  await Bun.write(paths.config, 'anthropicPromptCache = false\ntoolConcurrency = 1\nmaxToolResultBytes = 8192\nmaxToolOutputBytes = 2048\n');
  expect(await loadConfig()).toMatchObject({ anthropicPromptCache: false, toolConcurrency: 1, maxToolResultBytes: 8192, maxToolOutputBytes: 2048 });
  await Bun.write(paths.config, 'anthropicPromptCache = "yes"\ntoolConcurrency = 0\nmaxToolResultBytes = -1\nmaxToolOutputBytes = 1\n');
  expect(await loadConfig()).toMatchObject({ anthropicPromptCache: true, toolConcurrency: 4, maxToolResultBytes: 16384, maxToolOutputBytes: 67108864 });
});

test("execution configuration rejects invalid sandbox values and malformed TOML", async () => {
  await Bun.write(paths.config, 'sandbox = "workspce"\n');
  await expect(loadConfig({ strict: true })).rejects.toThrow("sandbox must be");
  await Bun.write(paths.config, 'sandbox = "workspace"\nmodel = [unclosed\n');
  await expect(loadConfig({ strict: true })).rejects.toThrow("invalid execution configuration");
  await Bun.write(paths.config, 'sandbox = "workspace"\n');
  expect((await loadConfig({ strict: true })).sandbox).toBe("workspace");
});

test("retired workflow settings do not affect configuration and disappear on save", async () => {
  await Bun.write(paths.config, 'model = "selected-model"\nmaxReviewRounds = 0\ndynamicDispatch = true\ncyclomatic = 7\ncognitive = 9\n');
  const config = await loadConfig({ strict: true });
  expect(config.model).toBe("selected-model");
  for (const key of ["maxReviewRounds", "dynamicDispatch", "cyclomatic", "cognitive"]) expect(config).not.toHaveProperty(key);
  await saveConfig({ toolConcurrency: 2 });
  const saved = await Bun.file(paths.config).text();
  for (const key of ["maxReviewRounds", "dynamicDispatch", "cyclomatic", "cognitive"]) expect(saved).not.toContain(key);
  expect(await loadConfig()).toMatchObject({ model: "selected-model", toolConcurrency: 2 });
});

test("malformed TOML warns once and strict execution still refuses it", async () => {
  const errors: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  try {
    await Bun.write(paths.config, 'model = [unclosed\n');
    expect(await loadConfig()).toEqual(defaults);
    expect(await loadConfig()).toEqual(defaults);
    expect(errors).toHaveLength(1);
    await expect(loadConfig({ strict: true })).rejects.toThrow("invalid execution configuration");
  } finally { console.error = original; }
});
