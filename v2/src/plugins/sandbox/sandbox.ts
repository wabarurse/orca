import { fail, ok, type Result } from "../../config";

export const MAC_PROFILE = `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath (param "SCRATCH")) (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/fd/") (regex #"^/dev/tty"))`;

export type Platform = { os: string; which: (bin: string) => string | null };

export function sandboxArgv(platform: Platform, scratch: string, cwd: string, command: string): Result<string[]> {
  if (platform.os === "darwin") {
    const exec = platform.which("sandbox-exec");
    if (exec === null) return fail("sandbox-exec is not available on this Mac");
    return ok([exec, "-D", `SCRATCH=${scratch}`, "-p", MAC_PROFILE, "bash", "-c", command]);
  }
  if (platform.os === "linux") {
    const bwrap = platform.which("bwrap");
    if (bwrap === null) return fail("bwrap (bubblewrap) is not installed; install it to use the sandbox");
    return ok([bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", scratch, scratch,
      "--chdir", cwd, "--unshare-pid", "--die-with-parent", "--new-session", "bash", "-c", command]);
  }
  return fail(`no sandbox on ${platform.os}`);
}
