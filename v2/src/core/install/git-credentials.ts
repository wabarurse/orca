import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail, type Result } from "../../config";
import type { Env, UpdateCommand } from "./command";

const quote = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\t", "\\t").replaceAll('"', '\\"')}"`;

export function credentialConfig(output: string): string {
  const fields = output.split("\0"), entries: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i] ?? "", record = fields[i + 1] ?? "";
    if (!["system", "global", "unknown"].includes(scope)) continue;
    const split = record.indexOf("\n");
    const key = split < 0 ? record : record.slice(0, split);
    if (!key.startsWith("credential.")) continue;
    const dot = key.lastIndexOf("."), variable = key.slice(dot + 1);
    const subsection = dot === "credential".length ? "" : ` ${quote(key.slice("credential.".length, dot))}`;
    const value = split < 0 ? "" : ` = ${quote(record.slice(split + 1))}`;
    entries.push(`[credential${subsection}]\n\t${variable}${value}\n`);
  }
  return entries.join("");
}

export async function withGitCredentials<T>(git: string, cwd: string, env: Env, command: UpdateCommand, action: (env: Env) => Promise<Result<T>>): Promise<Result<T>> {
  const readEnv: Env = Object.fromEntries(Object.entries(env).filter(([key]) => !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL"].includes(key)));
  const result = await command([git, "config", "--includes", "--null", "--show-scope", "--list"], cwd, readEnv);
  if (result.code !== 0) return fail("could not read git credential configuration; check your system/global git config");
  const credentials = credentialConfig(result.out);
  if (credentials.length === 0) return action(env);
  const directory = await mkdtemp(join(tmpdir(), "orca2-git-auth-"));
  try {
    const file = join(directory, "config");
    await writeFile(file, credentials, { flag: "wx", mode: 0o600 });
    return await action({ ...env, GIT_CONFIG_GLOBAL: file });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
