import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../config";
import { chooseMux } from "./mux";
import type { Choice } from "./model";

let home: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ["ORCA_HOME", "REX_BIN_DIR"]) saved[key] = process.env[key];
  home = mkdtempSync(join(tmpdir(), "orca-mux-"));
  writeFileSync(join(home, "rex"), "#!/bin/sh\n", { mode: 0o755 }); // Rex counts as installed; nothing calls it
  Object.assign(process.env, { ORCA_HOME: home, REX_BIN_DIR: home });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(home, { recursive: true, force: true });
});

const host = () => {
  const notes: string[] = [], menus: { title: string; choices: Choice<"tmux" | "rex">[]; pick: (mux: "tmux" | "rex") => Promise<void> }[] = [];
  return { notes, menus, open: (title: string, choices: Choice<"tmux" | "rex">[], pick: (mux: "tmux" | "rex") => Promise<void>) => { menus.push({ title, choices, pick }); }, note: (text: string) => { notes.push(text); } };
};

test("/mux rex saves it for new agents; /mux alone offers both with the current one marked", async () => {
  const h = host();
  await chooseMux("rex", h);
  expect((await loadConfig()).mux).toBe("rex");
  expect(h.notes).toEqual(["new agents start in rex; running ones stay where they are"]);
  await chooseMux("", h);
  expect(h.menus[0]!.choices.map(c => [c.value, c.current])).toEqual([["tmux", false], ["rex", true]]);
  await h.menus[0]!.pick("tmux");
  expect((await loadConfig()).mux).toBe("tmux");
});

test("an unknown multiplexer saves nothing", async () => {
  const h = host();
  await chooseMux("screen", h);
  expect(h.notes).toEqual(["unknown multiplexer screen; choose tmux or rex"]);
  expect((await loadConfig()).mux).toBe("tmux");
});
