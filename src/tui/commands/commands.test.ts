import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgents, agentWindows } from "../../core/tmux/liveness";
import { deleteProject } from "./project";
import { displayName, newProjectName, orderProjects, orderedProjects, repoHere, setDisplayName, shortRemote, togglePin, validProjectName } from "../../core/data/projects/registry";
import { DYNAMIC_DISPATCH_USAGE, dynamicDispatch, REVIEW_ROUNDS_USAGE, reviewRounds } from "./settings";
import { recentModels } from "./model";
import { loadConfig, paths, saveConfig } from "../../config/config";
import { effectiveFlow } from "../../core/data/projects/flow";
import { tmux } from "../../core/tmux/runner";

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
    for (const bad of ["", "a/b", "..", "."]) expect(validProjectName(bad)).toBe(false);
  });
});

describe("display names", () => {
  test("are saved per project, keep the folder, and must be unique", async () => {
    const home = mkdtempSync(join(tmpdir(), "orca-names-"));
    const before = process.env.ORCA_HOME;
    process.env.ORCA_HOME = home;
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
      if (before === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("repoHere", () => {
  test("shortRemote drops scheme and .git", () => {
    expect(shortRemote("https://github.com/example/orca.git")).toBe("github.com/example/orca");
    expect(shortRemote("git@github.com:me/app.git")).toBe("github.com/me/app");
  });
  test("retains the original checkout path even when it has an origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-here-"));
    try {
      const repo = join(dir, "my-app");
      await Bun.$`git init -q ${repo}`.quiet();
      expect(await repoHere(repo)).toBe(realpathSync(repo));
      await Bun.$`git -C ${repo} remote add origin git@example.com:me/my-app.git`.quiet();
      expect(await repoHere(join(repo))).toBe(realpathSync(repo));
      expect(await repoHere(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("/dynamic-dispatch", () => {
  test("shows, saves per project and refuses; config.toml is the default and stays untouched", async () => {
    const before = process.env.ORCA_HOME;
    const home = mkdtempSync(join(tmpdir(), "orca-dispatch-"));
    process.env.ORCA_HOME = home;
    mkdirSync(paths.project("one"), { recursive: true });
    mkdirSync(paths.project("two"), { recursive: true });
    try {
      expect(await dynamicDispatch("one", "")).toBe("dynamic dispatch: off");
      expect(await dynamicDispatch("one", "on")).toBe("dynamic dispatch set to on for this project; applies from the orchestrator's next turn");
      expect((await effectiveFlow("one")).dynamicDispatch).toBe(true);
      expect(await dynamicDispatch("one", "")).toBe("dynamic dispatch: on");
      expect(await dynamicDispatch("two", "")).toBe("dynamic dispatch: off"); // another project keeps the default
      expect((await loadConfig()).dynamicDispatch).toBe(false); // the global default is never written
      for (const bad of ["ON", "true", "1", "yes", "on off", "of"]) expect(await dynamicDispatch("one", bad)).toBe(DYNAMIC_DISPATCH_USAGE);
      expect(DYNAMIC_DISPATCH_USAGE).toBe(DYNAMIC_DISPATCH_USAGE.toLowerCase());
      expect((await effectiveFlow("one")).dynamicDispatch).toBe(true);
      expect(await dynamicDispatch("one", "off")).toBe("dynamic dispatch set to off for this project; applies from the orchestrator's next turn");
      expect(await dynamicDispatch("one", "")).toBe("dynamic dispatch: off");
      // config.toml supplies the default for projects without an override; a saved override wins over it.
      await saveConfig({ dynamicDispatch: true });
      expect(await dynamicDispatch("two", "")).toBe("dynamic dispatch: on");
      expect(await dynamicDispatch("one", "")).toBe("dynamic dispatch: off");
      await expect(dynamicDispatch("missing", "")).rejects.toThrow(); // no project directory: nothing to show or change
    } finally {
      if (before === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("/review-rounds", () => {
  test("shows, saves per project and refuses; config.toml is the default and stays untouched", async () => {
    const before = process.env.ORCA_HOME;
    const home = mkdtempSync(join(tmpdir(), "orca-rounds-"));
    process.env.ORCA_HOME = home;
    mkdirSync(paths.project("one"), { recursive: true });
    mkdirSync(paths.project("two"), { recursive: true });
    try {
      expect(await reviewRounds("one", "")).toBe("review rounds: 1");
      expect(await reviewRounds("one", "3")).toBe("review rounds set to 3 for this project; applies from the orchestrator's next turn");
      expect((await effectiveFlow("one")).maxReviewRounds).toBe(3);
      expect(await reviewRounds("two", "")).toBe("review rounds: 1");
      expect((await loadConfig()).maxReviewRounds).toBe(1);
      expect(await reviewRounds("one", "0")).toContain("set to 0");
      expect(await reviewRounds("one", "")).toBe("review rounds: 0");
      for (const bad of ["-1", "1.5", "two", "1e2", "1e23", "2 3", "101", "999", "0100", "9007199254740993"]) expect(await reviewRounds("one", bad)).toBe(REVIEW_ROUNDS_USAGE);
      expect((await effectiveFlow("one")).maxReviewRounds).toBe(0);
      await saveConfig({ maxReviewRounds: 5 });
      expect(await reviewRounds("two", "")).toBe("review rounds: 5");
      expect(await reviewRounds("one", "")).toBe("review rounds: 0");
      // Both settings share one file: saving one keeps the other.
      await dynamicDispatch("one", "on");
      expect(await effectiveFlow("one")).toEqual({ maxReviewRounds: 0, dynamicDispatch: true });
      expect(await reviewRounds("one", "2")).toContain("set to 2");
      expect(await effectiveFlow("one")).toEqual({ maxReviewRounds: 2, dynamicDispatch: true });
    } finally {
      if (before === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("project list", () => {
  const withHome = async (fn: (home: string) => Promise<void>) => {
    const prev = process.env.ORCA_HOME;
    const home = mkdtempSync(join(tmpdir(), "orca-projects-"));
    process.env.ORCA_HOME = home;
    try { await fn(home); } finally {
      if (prev === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  };
  const project = (home: string, name: string) => mkdirSync(join(home, "projects", name, "repo"), { recursive: true });

  const plain = (...names: string[]) => names.map((name) => ({ name, label: name }));

  test("orderProjects puts pins first, each group sorted, and drops stale pins", () => {
    expect(orderProjects(plain("c", "a", "b", "d"), ["d", "gone", "b"])).toEqual([
      { name: "b", label: "b", pinned: true }, { name: "d", label: "d", pinned: true },
      { name: "a", label: "a", pinned: false }, { name: "c", label: "c", pinned: false },
    ]);
  });

  test("orderProjects sorts each group by label, then id", () => {
    const projects = [
      { name: "orch-aaaa", label: "zebra" }, { name: "orch-bbbb", label: "apple" },
      { name: "orch-cccc", label: "mango" }, { name: "orch-dddd", label: "kiwi" }, { name: "b-id", label: "same" }, { name: "a-id", label: "same" },
    ];
    expect(orderProjects(projects, ["orch-aaaa", "orch-cccc"]).map((p) => `${p.pinned ? "*" : ""}${p.label}:${p.name}`)).toEqual([
      "*mango:orch-cccc", "*zebra:orch-aaaa", "apple:orch-bbbb", "kiwi:orch-dddd", "same:a-id", "same:b-id",
    ]);
  });

  test("orderedProjects labels each project with its display name", async () => {
    await withHome(async (home) => {
      project(home, "orch-zz11");
      project(home, "beta");
      await setDisplayName("orch-zz11", "alpha app");
      expect(await orderedProjects()).toEqual([
        { name: "orch-zz11", label: "alpha app", pinned: false }, { name: "beta", label: "beta", pinned: false },
      ]);
    });
  });

  test("pins are saved in config.toml and survive a reload", async () => {
    await withHome(async (home) => {
      for (const n of ["zeta", "alpha", "mid"]) project(home, n);
      expect((await orderedProjects()).map((p) => p.name)).toEqual(["alpha", "mid", "zeta"]);
      expect(await togglePin("zeta")).toBe(true);
      expect((await loadConfig()).pinned).toEqual(["zeta"]);
      expect(await Bun.file(paths.config).text()).toContain('pinned = ["zeta"]');
      expect((await orderedProjects()).map((p) => `${p.pinned ? "*" : ""}${p.name}`)).toEqual(["*zeta", "alpha", "mid"]);
      expect(await togglePin("zeta")).toBe(false);
      expect((await loadConfig()).pinned).toEqual([]);
    });
  });

  test("agentWindows ignores the session's idle shell and the orchestrator daemon's window", () => {
    expect(agentWindows(["shell", "orchestrator", "worker-x", "reviewer-x"])).toEqual(["worker-x", "reviewer-x"]);
    expect(agentWindows(["shell"])).toEqual([]);
    expect(agentWindows([])).toEqual([]);
  });

  test("togglePin and deleteProject keep the other config keys", async () => {
    await withHome(async (home) => {
      project(home, "keep");
      project(home, "gone");
      await saveConfig({ model: "gpt-test", maxReviewRounds: 5 });
      await togglePin("keep");
      await togglePin("gone");
      await deleteProject("gone", { live: async () => [], kill: async () => {} });
      const cfg = await loadConfig();
      expect(cfg.model).toBe("gpt-test");
      expect(cfg.maxReviewRounds).toBe(5);
      expect(cfg.pinned).toEqual(["keep"]);
    });
  });

  test("deleteProject removes the directory and its pin, after the hook", async () => {
    await withHome(async (home) => {
      project(home, "doomed");
      mkdirSync(join(home, "projects", "doomed", "transcript"), { recursive: true });
      await togglePin("doomed");
      const order: string[] = [];
      const killed: string[] = [];
      // The orchestrator daemon is stopped (and waited for) before the session dies and anything is removed.
      await deleteProject("doomed", { live: async () => [], stop: async (p) => { order.push(`stop ${p}`); }, kill: async (p) => { killed.push(p); order.push("kill"); }, beforeRemove: () => { order.push(existsSync(join(home, "projects", "doomed")) ? "present" : "gone"); } });
      expect(order).toEqual(["stop doomed", "kill", "present"]);
      expect(killed).toEqual(["doomed"]);
      expect(existsSync(join(home, "projects", "doomed"))).toBe(false);
      expect((await loadConfig()).pinned).toEqual([]);
    });
  });

  test("deleteProject refuses while agents are live, and bad or missing names", async () => {
    await withHome(async (home) => {
      project(home, "busy");
      let hooked = false;
      let stopped = false;
      const attempt = deleteProject("busy", { live: async () => ["worker-x"], stop: async () => { stopped = true; }, beforeRemove: () => { hooked = true; } });
      await expect(attempt).rejects.toThrow("live agents (worker-x)");
      expect(hooked).toBe(false);
      expect(stopped).toBe(false); // the daemon keeps running while its project stays
      expect(existsSync(join(home, "projects", "busy", "repo"))).toBe(true);
      for (const bad of ["../busy", "", "a/b", "..", "."]) await expect(deleteProject(bad, { live: async () => [] })).rejects.toThrow("not a project name");
      await expect(deleteProject("nope", { live: async () => [] })).rejects.toThrow("no project named nope");
    });
  });
});

describe("listAgents", () => {
  const withProject = async (fn: (project: string, home: string) => Promise<void>) => {
    const prev = process.env.ORCA_HOME;
    const home = mkdtempSync(join(tmpdir(), "orca-agents-"));
    process.env.ORCA_HOME = home;
    const windows = tmux.listWindows;
    try { await fn("p", home); } finally {
      tmux.listWindows = windows;
      if (prev === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  };
  const transcript = (project: string, name: string, firstTs?: string) => {
    mkdirSync(join(paths.transcript(project, "x"), ".."), { recursive: true });
    const lines = [{ uuid: "1", ts: firstTs, type: "meta" }, { uuid: "2", ts: "2030-01-01T00:00:00.000Z", type: "meta" }].map((e) => JSON.stringify(e));
    writeFileSync(paths.transcript(project, name), lines.join("\n") + "\n");
  };
  const state = (project: string, name: string, patch: Record<string, unknown>) => {
    mkdirSync(paths.runs(project), { recursive: true });
    writeFileSync(join(paths.runs(project), `${name}.json`), JSON.stringify({ run: "r", pid: 1, role: "worker", state: "running", step: "", tool: "", ts: "2024-05-01T10:30:00.000Z", ...patch }));
  };
  const by = (list: Awaited<ReturnType<typeof listAgents>>, name: string) => list.find((a) => a.name === name);

  test("live and finished agents carry their latest run's times; the orchestrator is not listed", async () => {
    await withProject(async (project) => {
      tmux.listWindows = async () => ["shell", "worker-a"];
      for (const n of ["orchestrator", "worker-a", "worker-b"]) transcript(project, n, "2020-01-01T00:00:00.000Z");
      state(project, "worker-a", { startedAt: "2024-05-01T10:00:00.000Z" });
      state(project, "worker-b", { startedAt: "2024-05-01T09:00:00.000Z", endedAt: "2024-05-01T09:14:02.000Z" });
      const list = await listAgents(project);
      expect(list.map((a) => a.name).sort()).toEqual(["worker-a", "worker-b"]);
      expect(by(list, "worker-a")).toEqual({ name: "worker-a", live: true, startedAt: "2024-05-01T10:00:00.000Z" });
      expect(by(list, "worker-b")).toEqual({ name: "worker-b", live: false, startedAt: "2024-05-01T09:00:00.000Z", endedAt: "2024-05-01T09:14:02.000Z" });
    });
  });

  test("a live agent that reported still counts as live and has no end", async () => {
    await withProject(async (project) => {
      tmux.listWindows = async () => ["worker-a"];
      transcript(project, "worker-a");
      state(project, "worker-a", { state: "reported", startedAt: "2024-05-01T10:00:00.000Z" });
      expect(by(await listAgents(project), "worker-a")).toEqual({ name: "worker-a", live: true, startedAt: "2024-05-01T10:00:00.000Z" });
    });
  });

  test("a finished agent without endedAt ends approximately at the state's last update", async () => {
    await withProject(async (project) => {
      tmux.listWindows = async () => [];
      transcript(project, "worker-k");
      state(project, "worker-k", { startedAt: "2024-05-01T10:00:00.000Z" });
      expect(by(await listAgents(project), "worker-k")).toEqual({ name: "worker-k", live: false, startedAt: "2024-05-01T10:00:00.000Z", endedAt: "2024-05-01T10:30:00.000Z", approximateEnd: true });
    });
  });

  test("live window with a previous run's endedAt shows no clock", async () => {
    await withProject(async (project) => {
      tmux.listWindows = async () => ["worker-r"];
      transcript(project, "worker-r", "2024-05-01T08:00:00.000Z");
      state(project, "worker-r", { startedAt: "2024-05-01T09:00:00.000Z", endedAt: "2024-05-01T09:30:00.000Z" });
      expect(by(await listAgents(project), "worker-r")).toEqual({ name: "worker-r", live: true });
    });
  });

  test("an old state file without startedAt starts at the transcript's first entry", async () => {
    await withProject(async (project) => {
      tmux.listWindows = async () => ["worker-o"];
      transcript(project, "worker-o", "2024-05-01T08:00:00.000Z");
      transcript(project, "worker-p", "2024-05-01T08:00:00.000Z");
      state(project, "worker-o", {});
      state(project, "worker-p", { endedAt: "2024-05-01T09:00:00.000Z" });
      const list = await listAgents(project);
      expect(by(list, "worker-o")).toEqual({ name: "worker-o", live: true, startedAt: "2024-05-01T08:00:00.000Z" });
      expect(by(list, "worker-p")).toEqual({ name: "worker-p", live: false, startedAt: "2024-05-01T08:00:00.000Z", endedAt: "2024-05-01T09:00:00.000Z" });
    });
  });

  test("with no state file, only the transcript start is known; with nothing usable there is no time at all", async () => {
    await withProject(async (project) => {
      tmux.listWindows = async () => ["worker-l"];
      transcript(project, "worker-l", "2024-05-01T08:00:00.000Z");
      transcript(project, "worker-f", "2024-05-01T08:00:00.000Z");
      transcript(project, "worker-n"); // first entry has no ts
      writeFileSync(paths.transcript(project, "worker-e"), "");
      writeFileSync(paths.transcript(project, "worker-g"), "not json\n");
      const list = await listAgents(project);
      expect(by(list, "worker-l")).toEqual({ name: "worker-l", live: true, startedAt: "2024-05-01T08:00:00.000Z" });
      expect(by(list, "worker-f")).toEqual({ name: "worker-f", live: false, startedAt: "2024-05-01T08:00:00.000Z" });
      for (const n of ["worker-n", "worker-e", "worker-g"]) expect(by(list, n)).toEqual({ name: n, live: false });
    });
  });

  test("only the first transcript line is read", async () => {
    await withProject(async (project) => {
      tmux.listWindows = async () => [];
      mkdirSync(join(paths.transcript(project, "x"), ".."), { recursive: true });
      writeFileSync(paths.transcript(project, "worker-big"), JSON.stringify({ ts: "2024-05-01T08:00:00.000Z" }) + "\n" + "x".repeat(5_000_000));
      expect(by(await listAgents(project), "worker-big")?.startedAt).toBe("2024-05-01T08:00:00.000Z");
    });
  });
});
