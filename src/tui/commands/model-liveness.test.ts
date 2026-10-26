// Exercise tmux.windows' real error classification through a fake executable;
// never invoke the user's tmux server or require a transcript directory.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const home = mkdtempSync(join(tmpdir(), "model-liveness-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
for (const error of ["can't find session: missing", "no server running", "permission denied"]) {
  test(`production liveness classifies ${error}`, async () => {
    const bin = join(home, error.replace(/[^a-z]/g, ""));
    mkdirSync(bin);
    const executable = join(bin, "tmux");
    await Bun.write(executable, `#!/bin/sh\nprintf '%s\\n' "$FAKE_TMUX_ERROR" >&2\nexit 1\n`);
    chmodSync(executable, 0o755);
    const commands = join(import.meta.dir, "commands.ts");
    const child = Bun.spawn([process.execPath, "-e", `import {liveAgentsOrNull} from ${JSON.stringify(commands)}; console.log(JSON.stringify(await liveAgentsOrNull("missing")));`], {
      env: { ...process.env, PATH: bin, ORCA_HOME: home, FAKE_TMUX_ERROR: error }, stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual(error === "permission denied" ? null : []);
  });
}
