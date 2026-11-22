import { resolve, sep } from "node:path";
import { loadConfig, saveConfig } from "../config";

export type TrustState = "trusted" | "untrusted";

const within = (folder: string, root: string): boolean => folder === root || folder.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

export async function trustState(directory: string): Promise<TrustState> {
  const folder = resolve(directory);
  const config = await loadConfig();
  return config.untrusted.some(root => within(folder, resolve(root))) ? "untrusted" : "trusted";
}

export async function setTrust(directory: string, trusted: boolean): Promise<void> {
  const folder = resolve(directory);
  const config = await loadConfig();
  const rest = config.untrusted.filter(root => resolve(root) !== folder);
  await saveConfig({ untrusted: trusted ? rest : [...rest, folder] });
}
