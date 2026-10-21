import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newProjectName, repoHere, shortRemote, validProjectName } from "./commands";
import { recentModels } from "./commands";

describe("recentModels", () => {
  const ids = ["m6", "m5", "m4", "m3", "m2", "m1", "m0"];
  test("keeps the newest few", () => {
    expect(recentModels(ids, "m5", 3)).toEqual(["m6", "m5", "m4"]);
  });
  test("adds the current model when it is older than the cut", () => {
    expect(recentModels(ids, "m0", 3)).toEqual(["m6", "m5", "m4", "m0"]);
  });
  test("ignores a current model the provider does not list", () => {
    expect(recentModels(ids, "other", 3)).toEqual(["m6", "m5", "m4"]);
  });
});

describe("project names", () => {
  test("newProjectName is orch-xxxx and avoids taken names", () => {
    const first = newProjectName([]);
    expect(first).toMatch(/^orch-[a-z0-9]{4}$/);
    const taken = Array.from({ length: 50 }, () => newProjectName([]));
    expect(taken.every((n) => /^orch-[a-z0-9]{4}$/.test(n))).toBe(true);
  });
  test("validProjectName", () => {
    expect(validProjectName("login-page")).toBe(true);
    expect(validProjectName("bad name")).toBe(false);
    expect(validProjectName("../x")).toBe(false);
  });
});

describe("repoHere", () => {
  test("shortRemote drops scheme and .git", () => {
    expect(shortRemote("https://github.com/wabarurse/parallels.git")).toBe("github.com/wabarurse/parallels");
    expect(shortRemote("git@github.com:me/app.git")).toBe("github.com/me/app");
  });
  test("prefers the origin url over the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "parallels-here-"));
    try {
      const repo = join(dir, "my-app");
      await Bun.$`git init -q ${repo}`.quiet();
      expect(await repoHere(repo)).toBe(realpathSync(repo));
      await Bun.$`git -C ${repo} remote add origin git@example.com:me/my-app.git`.quiet();
      expect(await repoHere(join(repo))).toBe("git@example.com:me/my-app.git");
      expect(await repoHere(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
