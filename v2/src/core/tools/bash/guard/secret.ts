import { basename } from "node:path";
import { expandPath } from "./shell";

export const SECRET_REASON = "keys, .env files and credentials must not enter the transcript";
export const SECRET_SUGGESTION = "printenv NAME for one variable, or ask the user for what you need";

const KEYS = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?!.*\.pub$)/;
const SAFE_ENV = new Set(["example", "sample", "template", "dist"]);
export function secretPath(path: string): boolean {
  const expanded = path === "~" || path.startsWith("~/") ? (expandPath(path, process.env) ?? path) : path;
  const parts = expanded.split("/").filter(p => p.length > 0);
  const base = basename(expanded);
  if (parts.includes(".ssh")) return true;
  if (base === ".env") return true;
  if (base.startsWith(".env.") && !SAFE_ENV.has(base.slice(5))) return true;
  if (base === "credentials" && parts.at(-2) === ".aws") return true;
  if (base === ".netrc" || base === "_netrc") return true;
  return base.endsWith(".pem") || KEYS.test(base);
}
