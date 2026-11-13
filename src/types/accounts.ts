export type ProviderName = "anthropic" | "openai";

/** One subscription login: a provider and one of its profiles. A project selects exactly one. */
export interface AccountRef { provider: ProviderName; profile: string }

/** A row in /accounts. */
export interface Account {
  /** "anthropic:<profile>" or "openai:<profile>". */
  id: string;
  provider: ProviderName;
  profile: string;
  ok: boolean;
  active: boolean;
  source: string;
}
