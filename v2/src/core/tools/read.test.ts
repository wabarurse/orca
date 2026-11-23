import { describe, expect, test } from "bun:test";
import { noLinks } from "../plugins/testing";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { tempHome } from "../../test/home";
import { fakeProvider } from "../../test/fake-provider";
import { read } from "./read";
import type { ToolContext } from "./registry";
import { write } from "./write";

const home = tempHome("read");

const ctx = (): ToolContext => ({ conversation: "c-00000000", agent: "worker", role: "worker", branch: null, cwd: home.path(), data: home.path(), trusted: false, pluginSkills: [], guard: [],
  callId: "call", signal: new AbortController().signal, model: "fake-model", provider: fakeProvider([]), settings: null,
  runtime: { spawn: async () => { throw new Error("no spawn"); }, agents: async () => [], stop: async () => "", confirm: async () => false }, links: noLinks });

const SECRET = { rule: "secret-file", message: "refused (secret-file): keys, .env files and credentials must not enter the transcript. Use: printenv NAME for one variable, or ask the user for what you need" };

describe("read", () => {
  test("refuses secret files and nothing else", async () => {
    writeFileSync(join(home.path(), "a.ts"), "one\ntwo\n");
    writeFileSync(join(home.path(), ".env"), "TOKEN=private\n");
    await expect(read.run({ path: ".env" }, ctx())).rejects.toMatchObject(SECRET);
    await expect(read.run({ path: "~/.ssh/id_ed25519" }, ctx())).rejects.toMatchObject(SECRET);
    await expect(read.run({ files: [{ path: "a.ts" }, { path: "/home/x/.ssh/id_ed25519" }] }, ctx())).rejects.toMatchObject(SECRET);
    const text = await read.run({ path: "a.ts" }, ctx());
    expect(z.object({ content: z.string() }).parse(JSON.parse(typeof text === "string" ? text : "")).content).toBe("1: one\n2: two\n3: ");
    expect(await write.run({ path: ".env.local", content: "A=1\n" }, ctx())).toContain("\"previous_revision\":null");
  });
});
