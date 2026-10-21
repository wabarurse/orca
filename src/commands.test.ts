import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayName, newProjectName, repoHere, setDisplayName, shortRemote, validProjectName } from "./commands";
import { recentModels, REVIEW_ROUNDS_USAGE, reviewRounds } from "./commands";
import { loadConfig } from "./config";

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

describe("display names", () => {
  test("are saved per project, keep the folder, and must be unique", async () => {
    const home = mkdtempSync(join(tmpdir(), "parallels-names-"));
    const before = process.env.PARALLELS_HOME;
    process.env.PARALLELS_HOME = home;
    try {
      for (const p of ["a", "b"]) mkdirSync(join(home, "projects", p, "repo"), { recursive: true });
      expect(await displayName("a")).toBe("a");
      expect(await setDisplayName("a", "  login page ")).toBe("login page");
      expect(await displayName("a")).toBe("login page");
      expect(existsSync(join(home, "projects", "a", "repo"))).toBe(true);
      await expect(setDisplayName("b", "login page")).rejects.toThrow("already called");
      await expect(setDisplayName("b", "a")).rejects.toThrow("already called");
      await expect(setDisplayName("b", "")).rejects.toThrow("printable");
      await expect(setDisplayName("b", "x\ny")).rejects.toThrow("printable");
      for (const bad of ["x\x85y", "x\x9by", "\u202eevil", "a\u2066b", "a\u2069"]) await expect(setDisplayName("b", bad)).rejects.toThrow("printable");
      expect(await setDisplayName("b", "café ✓")).toBe("café ✓");
      expect(await setDisplayName("a", "login page")).toBe("login page"); // its own name again is fine
    } finally {
      if (before === undefined) delete process.env.PARALLELS_HOME; else process.env.PARALLELS_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
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

describe("/review-rounds", () => {
  test("shows, saves and refuses", async () => {
    const before = process.env.PARALLELS_HOME;
    const home = mkdtempSync(join(tmpdir(), "parallels-rounds-"));
    process.env.PARALLELS_HOME = home;
    try {
      expect(await reviewRounds("")).toBe("review rounds: 1");
      expect(await reviewRounds("3")).toContain("next turn");
      expect((await loadConfig()).maxReviewRounds).toBe(3);
      expect(await reviewRounds("0")).toContain("set to 0");
      expect(await reviewRounds("")).toBe("review rounds: 0");
      for (const bad of ["-1", "1.5", "two", "1e2", "1e23", "2 3", "101", "999", "0100", "9007199254740993"]) expect(await reviewRounds(bad)).toBe(REVIEW_ROUNDS_USAGE);
      expect((await loadConfig()).maxReviewRounds).toBe(0);
    } finally {
      if (before === undefined) delete process.env.PARALLELS_HOME; else process.env.PARALLELS_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
