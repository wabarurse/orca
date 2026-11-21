import { resolve, sep } from "node:path";
import { loadConfig, saveConfig } from "../config";

export type TrustState = "trusted" | "untrusted" | "unknown";

const within = (folder: string, root: string): boolean => folder === root || folder.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

export function trustForRun(directory: string): void { process.env.ORCA2_TRUST_RUN = resolve(directory); }

export async function trustState(directory: string): Promise<TrustState> {
  const folder = resolve(directory);
  const run = process.env.ORCA2_TRUST_RUN;
  if (run !== undefined && run.length > 0 && within(folder, run)) return "trusted";
  const config = await loadConfig();
  if (config.untrusted.some(root => within(folder, resolve(root)))) return "untrusted";
  if (config.trusted.some(root => within(folder, resolve(root)))) return "trusted";
  return "unknown";
}

export async function setTrust(directory: string, trusted: boolean): Promise<void> {
  const folder = resolve(directory);
  const config = await loadConfig();
  const without = (list: string[]): string[] => list.filter(root => resolve(root) !== folder);
  await saveConfig(trusted ? { trusted: [...without(config.trusted), folder], untrusted: without(config.untrusted) }
    : { untrusted: [...without(config.untrusted), folder], trusted: without(config.trusted) });
}

export const trustQuestion = (directory: string): string =>
  `Trust ${directory}? Its AGENTS.md/CLAUDE.md instructions, skills (.agents/skills, .claude/skills) and plugins (.orca2/plugins) will load into agents.`;
