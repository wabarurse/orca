// How a sandboxed command is started: macOS `sandbox-exec` with a profile that denies every file write outside the
// scratch folder (and a few devices), Linux `bwrap` with the whole filesystem read-only except the scratch folder.
// No sandbox, no run: there is never an unsandboxed fallback.

/** The macOS profile; the scratch folder comes in as the SCRATCH parameter, so nothing is spliced into it. */
export const MAC_PROFILE = `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath (param "SCRATCH")) (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/fd/") (regex #"^/dev/tty"))`;

export type Platform = { os: string; which: (bin: string) => string | null };

/** The argv that runs `command` in a sandbox writing only to `scratch` (a real path), or why it cannot. */
export function sandboxArgv(platform: Platform, scratch: string, cwd: string, command: string): { argv: string[] } | { refused: string } {
  if (platform.os === "darwin") {
    const exec = platform.which("sandbox-exec");
    if (exec === null) return { refused: "sandbox-exec is not available on this Mac" };
    return { argv: [exec, "-D", `SCRATCH=${scratch}`, "-p", MAC_PROFILE, "bash", "-c", command] };
  }
  if (platform.os === "linux") {
    const bwrap = platform.which("bwrap");
    if (bwrap === null) return { refused: "bwrap (bubblewrap) is not installed; install it to use the sandbox" };
    return { argv: [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", scratch, scratch,
      "--chdir", cwd, "--unshare-pid", "--die-with-parent", "--new-session", "bash", "-c", command] };
  }
  return { refused: `no sandbox on ${platform.os}` };
}
