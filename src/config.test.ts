import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, loadConfig, paths, saveConfig } from "./config";

let home: string;
const before = process.env.PARALLELS_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "parallels-config-")); process.env.PARALLELS_HOME = home; });
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (before === undefined) delete process.env.PARALLELS_HOME; else process.env.PARALLELS_HOME = before;
});

describe("maxReviewRounds", () => {
  test("defaults to 1", async () => {
    expect(defaults.maxReviewRounds).toBe(1);
    expect((await loadConfig()).maxReviewRounds).toBe(1);
  });
  test("reads any non-negative integer", async () => {
    await Bun.write(paths.config, "maxReviewRounds = 0\n");
    expect((await loadConfig()).maxReviewRounds).toBe(0);
    await Bun.write(paths.config, "maxReviewRounds = 4\n");
    expect((await loadConfig()).maxReviewRounds).toBe(4);
  });
  test("anything else falls back to the default", async () => {
    for (const bad of [`"2"`, "-1", "1.5", "true", "101", "1e21", "1e23"]) {
      await Bun.write(paths.config, `maxReviewRounds = ${bad}\n`);
      expect((await loadConfig()).maxReviewRounds).toBe(defaults.maxReviewRounds);
    }
  });
  test("100 is the most it reads", async () => {
    await Bun.write(paths.config, "maxReviewRounds = 100\n");
    expect((await loadConfig()).maxReviewRounds).toBe(100);
  });
  test("a config.toml that does not parse falls back to defaults and warns once", async () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
    try {
      await Bun.write(paths.config, "maxReviewRounds = 9007199254740993\n");
      expect(await loadConfig()).toEqual(defaults);
      expect(await loadConfig()).toEqual(defaults);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain(paths.config);
      await Bun.write(paths.config, "model = [unclosed\n");
      expect(await loadConfig()).toEqual(defaults);
      expect(errors.length).toBe(2);
    } finally {
      console.error = orig;
    }
  });
  test("saveConfig keeps the other keys", async () => {
    await Bun.write(paths.config, `cyclomatic = 7\nmodel = "m"\n`);
    await saveConfig({ maxReviewRounds: 3 });
    const config = await loadConfig();
    expect(config.maxReviewRounds).toBe(3);
    expect(config.cyclomatic).toBe(7);
    expect(config.model).toBe("m");
  });
});

test("efficiency defaults are enabled and overrides remain bounded", async () => {
  expect((await loadConfig()).anthropicPromptCache).toBe(true);
  expect((await loadConfig()).toolConcurrency).toBe(4);
  await Bun.write(paths.config, 'anthropicPromptCache = false\ntoolConcurrency = 1\nmaxToolResultBytes = 8192\nmaxToolOutputBytes = 2048\n');
  expect(await loadConfig()).toMatchObject({ anthropicPromptCache: false, toolConcurrency: 1, maxToolResultBytes: 8192, maxToolOutputBytes: 2048 });
  await Bun.write(paths.config, 'anthropicPromptCache = "yes"\ntoolConcurrency = 0\nmaxToolResultBytes = -1\nmaxToolOutputBytes = 1\n');
  expect(await loadConfig()).toMatchObject({ anthropicPromptCache: true, toolConcurrency: 4, maxToolResultBytes: 16384, maxToolOutputBytes: 67108864 });
});
