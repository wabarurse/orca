import { fail, ok, type Result } from "../../config";
import { importClaudeCode, loginClaude } from "./claude";
import { importCodex, loginCodex } from "./codex";
import { type LoginOptions } from "./oauth";
import { type ProviderName } from "./accounts";

export const LOGIN_USAGE = "usage: login anthropic|openai [profile] [--import]";

export type LoginRequest = { provider: ProviderName; profile: string; imported: boolean };

export function parseLogin(args: string[]): Result<LoginRequest> {
  const [alias = "", ...rest] = args;
  const provider = alias === "claude" ? "anthropic" : alias === "codex" ? "openai" : alias;
  if (provider !== "anthropic" && provider !== "openai") return fail(LOGIN_USAGE);
  const flags = rest.filter(a => a.startsWith("--"));
  const names = rest.filter(a => !a.startsWith("--"));
  if (names.length > 1 || flags.length > 1 || flags.some(f => f !== "--import" && f !== "--from-claude-code" && f !== "--from-codex")) return fail(LOGIN_USAGE);
  return ok({ provider, profile: names.at(0) ?? "default", imported: flags.length > 0 });
}

export async function signIn(request: LoginRequest, options: LoginOptions): Promise<Result<null>> {
  if (request.imported) return request.provider === "anthropic" ? importClaudeCode(request.profile) : importCodex(request.profile);
  return request.provider === "anthropic" ? loginClaude(request.profile, options) : loginCodex(request.profile, options);
}
