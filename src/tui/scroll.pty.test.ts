// Real application/input lifecycle through an owned PTY with no user state or
// model requests. Injected SGR reports are NOT physical Apple Terminal gestures.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "../transcript";
import { FakeScreen } from "./testing";

const END_FRAME = "\x1b[?2026l";

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}

test("owned PTY: full saved history scrolls between pinned bars without mode changes; exit restores shell", async () => {
  const home = mkdtempSync(join(tmpdir(), "parallels-scroll-pty-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    mkdirSync(join(home, "projects", "probe", "repo"), { recursive: true });
    const t = open(join(home, "projects", "probe", "transcripts", "orchestrator.jsonl"));
    await t.append({ type: "meta", role: "orchestrator", model: "m" });
    await t.append({ type: "message", message: { role: "user", content: "PTY-ORIGINAL-HISTORY" } });
    for (let i = 0; i < 140; i++) await t.append({ type: "message", message: { role: "assistant", content: `PTY-RECORD-${i}` } });
    await t.append({ type: "summary", text: "PTY-MODEL-ONLY", retained: [], boundary: t.head() });
    await t.append({ type: "message", message: { role: "assistant", content: "PTY-LATEST-HISTORY" } });
    let output = "";
    const decoder = new TextDecoder();
    child = Bun.spawn(["/bin/sh", "-c", `
      printf 'STTY_BEFORE:%s\\n' "$(stty -g)"
      i=0; while [ "$i" -lt 60 ]; do printf 'PRELAUNCH_SENTINEL_%s\\n' "$i"; i=$((i + 1)); done
      "$1" "$2" start probe <&0 & app=$!
      trap 'kill -TERM "$app" 2>/dev/null; wait "$app"; exit 143' TERM HUP
      wait "$app"; result=$?
      trap - TERM HUP
      printf '\\nSTTY_AFTER:%s\\n' "$(stty -g)"
      exit "$result"
    `, "probe-shell", process.execPath, join(import.meta.dir, "..", "cli.ts")], {
      cwd: home,
      // No inherited auth, tmux server/socket, git config, or user's project.
      env: { HOME: home, PARALLELS_HOME: home, PATH: "/usr/bin:/bin", TERM: "xterm-256color", SSH_TTY: "fixture-no-desktop", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      terminal: { cols: 100, rows: 24, data(_terminal, data) { output += decoder.decode(data, { stream: true }); } },
    });
    const screen = () => {
      const s = new FakeScreen(100, 24);
      // Output callbacks can split escape sequences; replay complete frames only.
      s.write(output.slice(0, output.lastIndexOf(END_FRAME) + END_FRAME.length));
      return s.screen();
    };
    await until(() => output.includes("PTY-LATEST-HISTORY"));
    child.terminal!.write("\x1b[200~PTY-DRAFT\nsecond line\x1b[201~");
    await until(() => screen().some(row => row.includes("second line")));
    const initial = screen(), headerEnd = initial.findIndex(row => /^─+$/.test(row)) + 1;
    const header = initial.slice(0, headerEnd), footer = initial.slice(-5);
    child.terminal!.write("\x1b[<64;10;8M".repeat(120));
    await until(() => screen()[headerEnd] === "> PTY-ORIGINAL-HISTORY");
    child.terminal!.write("\x1b[<64;10;8M".repeat(20));
    await Bun.sleep(40);
    expect(screen().slice(0, headerEnd)).toEqual(header);
    expect(screen().slice(-5)).toEqual(footer);
    expect(screen().join("\n")).not.toContain("PRELAUNCH_SENTINEL");
    expect(output.split("\x1b[?1049h")).toHaveLength(2);
    expect(output.split("\x1b[?2004h")).toHaveLength(2);
    for (const mode of [1000, 1002, 1006]) expect(output).toContain(`\x1b[?${mode}h`);
    expect(output).not.toContain("\x1b[?1049l");
    expect(output).not.toContain("\x1b[3J");
    // Real raw input pipeline, injected reports, no physical gesture claims.
    // SSH guard ensures this PTY test can never mutate the host clipboard.
    const y = headerEnd + 1;
    child.terminal!.write(`\x1b[<0;3;${y}M\x1b[<32;5;${y}M\x1b[<0;5;${y}m`);
    await until(() => output.includes("\x1b[7mPTY\x1b[0m"));
    // Automatic copy uses the same SSH-guarded backend as explicit re-copy.
    child.terminal!.write("\x0f"); // explicit Ctrl+O, not Cmd-C
    await Bun.sleep(40);
    child.terminal!.write("\x1b"); // clear highlight, preserve draft
    await Bun.sleep(40);
    child.terminal!.write("\x1b[<65;10;8M".repeat(120));
    await until(() => screen().some(row => row.includes("copy failed:")));
    expect(screen().join("\n")).toContain("unavailable over ssh");
    expect(screen().slice(-5)).toEqual(footer);
    // Clear only this synthetic fixture's draft, then exit through the real command.
    child.terminal!.write("\x1b");
    await Bun.sleep(40); // separate Esc from /quit (not an Alt+/ chord)
    child.terminal!.write("/quit\r");
    await until(() => output.includes("STTY_AFTER:"));
    expect(await child.exited).toBe(0);
    expect(output.match(/STTY_AFTER:([^\r\n]+)/)?.[1]).toBe(output.match(/STTY_BEFORE:([^\r\n]+)/)?.[1]);
    expect(output.split("\x1b[?1049l")).toHaveLength(2);
    const restored = new FakeScreen(100, 24);
    restored.write(output);
    expect(restored.text()).toContain("PRELAUNCH_SENTINEL_0");
    expect(restored.text()).toContain("PTY-ORIGINAL-HISTORY");
    expect(restored.text()).toContain("PTY-LATEST-HISTORY");
    expect(restored.text()).not.toContain("PTY-MODEL-ONLY");
    for (const mode of [1049, 1000, 1002, 1006, 2004]) expect(restored.modes.get(mode)).toBe(false);
  } finally {
    if (child) {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
      child.terminal?.close();
    }
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
