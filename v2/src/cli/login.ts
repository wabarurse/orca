// `orca2 login <anthropic|openai> [profile]` and `orca2 accounts`: subscription sign-in, kept under ~/.orca2.
import { accounts, importClaudeCode, importCodex, loginClaude, loginCodex } from "../api/auth";
import { saveConfig } from "../config";

export async function runLogin(args: string[], out: (text: string) => void): Promise<number> {
  const [name, profile = "default", flag] = args;
  if (name !== "anthropic" && name !== "openai") { out("usage: orca2 login anthropic|openai [profile] [--import]\n"); return 2; }
  const options = { write: out, openBrowser: async (url: string) => { Bun.spawn(process.platform === "darwin" ? ["open", url] : ["xdg-open", url], { stdout: "ignore", stderr: "ignore" }); } };
  if (flag === "--import") await (name === "anthropic" ? importClaudeCode(profile) : importCodex(profile));
  else await (name === "anthropic" ? loginClaude(profile, options) : loginCodex(profile, options));
  await saveConfig(name === "anthropic" ? { account: profile === "default" ? "" : profile } : { openaiAccount: profile === "default" ? "" : profile });
  out(`${name}:${profile} signed in\n`);
  return 0;
}

export async function runAccounts(out: (text: string) => void): Promise<number> {
  for (const account of await accounts()) out(`${account.ok ? "ok " : "-- "} ${account.id.padEnd(28)} ${account.source}\n`);
  return 0;
}
