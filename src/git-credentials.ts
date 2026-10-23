// Preserve Git's credential helper chain without importing global hooks,
// URL rewrites or repository selection settings into the harness updater.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateCommand } from "./pull";

const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\t", "\\t").replaceAll('"', '\\"')}"`;

/** Git's --null --show-scope format is scope NUL key LF value NUL. */
function credentialConfig(output: string): string {
  const fields = output.split("\0"), entries: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    // Apple Git reports its bundled system Keychain helper with scope "unknown".
    if (!["system", "global", "unknown"].includes(fields[i]!)) continue;
    const record = fields[i + 1]!, split = record.indexOf("\n");
    const key = split < 0 ? record : record.slice(0, split);
    if (!key.startsWith("credential.")) continue;
    const dot = key.lastIndexOf("."), variable = key.slice(dot + 1);
    const subsection = dot === "credential".length ? "" : ` ${quote(key.slice("credential.".length, dot))}`;
    // Keep valueless booleans and empty helper resets distinct, and preserve order.
    const value = split < 0 ? "" : ` = ${quote(record.slice(split + 1))}`;
    entries.push(`[credential${subsection}]\n\t${variable}${value}\n`);
  }
  return entries.join("");
}

export async function withGitCredentials<T>(git: string, cwd: string, env: NodeJS.ProcessEnv, command: UpdateCommand, action: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const readEnv = { ...env };
  for (const key of ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL"]) delete readEnv[key];
  const result = await command([git, "config", "--includes", "--null", "--show-scope", "--list"], cwd, readEnv);
  // Never echo configuration output or errors which might contain credentials.
  if (result.code !== 0) throw new Error("could not read git credential configuration; check your system/global git config");
  const credentials = credentialConfig(result.out);
  if (!credentials) return action(env);
  const directory = await mkdtemp(join(tmpdir(), "parallels-git-auth-"));
  try {
    const file = join(directory, "config");
    await writeFile(file, credentials, { flag: "wx", mode: 0o600 });
    // Flatten system + global credentials into the global layer so local config
    // retains its normal precedence, including empty credential.helper resets.
    return await action({ ...env, GIT_CONFIG_GLOBAL: file });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
