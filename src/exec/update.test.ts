import { expect, test } from "bun:test";
import { activateInstalled } from "./update";

test("activation invokes the installed binary with the global state root, independent of cwd and overrides", async () => {
  const before = process.env.ORCA_HOME, legacy = process.env.PARALLELS_HOME;
  process.env.ORCA_HOME = "/unrelated/state"; process.env.PARALLELS_HOME = "/another/state";
  try {
    let calls = 0;
    await activateInstalled("/fixture/.local/bin/orca", { home: "/fixture", run: async (argv, env) => {
      calls++;
      expect(argv).toEqual(["/fixture/.local/bin/orca", "reload"]);
      expect(env.ORCA_HOME).toBe("/fixture/.orca"); expect(env.PARALLELS_HOME).toBeUndefined(); return 0;
    } });
    expect(calls).toBe(1); expect(process.env.ORCA_HOME).toBe("/unrelated/state");
  } finally { process.env.ORCA_HOME = before; process.env.PARALLELS_HOME = legacy; }
});

test("activation failure reports that installation succeeded, without repeating or rolling back installation", async () => {
  const notices: string[] = [];
  await activateInstalled("/fixture/orca", { home: "/fixture", run: async () => { throw new Error("cannot launch"); }, write: s => notices.push(s) });
  expect(notices).toHaveLength(1); expect(notices[0]).toContain("installation succeeded"); expect(notices[0]).toContain("orca reload");
});
