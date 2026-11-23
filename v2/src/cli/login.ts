import { accounts, parseLogin, signIn } from "../api/auth";
import { saveConfig } from "../config";

export async function runLogin(args: string[], out: (text: string) => void): Promise<number> {
  const request = parseLogin(args);
  if (!request.ok) { out(`orca2 ${request.error}\n`); return 2; }
  const { provider, profile } = request.data;
  const options = { write: (text: string) => { out(`${text}\n`); }, openBrowser: async (url: string) => { Bun.spawn(process.platform === "darwin" ? ["open", url] : ["xdg-open", url], { stdout: "ignore", stderr: "ignore" }); } };
  const signed = await signIn(request.data, options);
  if (!signed.ok) { out(`orca2: ${signed.error}\n`); return 1; }
  await saveConfig(provider === "anthropic" ? { account: profile === "default" ? "" : profile } : { openaiAccount: profile === "default" ? "" : profile });
  out(`${provider}:${profile} signed in\n`);
  return 0;
}

export async function runAccounts(out: (text: string) => void): Promise<number> {
  const listed = await accounts();
  if (listed.length === 0) out("no accounts; orca2 login anthropic|openai [profile] signs in\n");
  for (const account of listed) out(`${account.ok ? "ok " : "-- "} ${account.id.padEnd(28)} ${account.source}\n`);
  return 0;
}
