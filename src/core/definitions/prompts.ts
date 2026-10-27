import type { Role } from "../../protocol";
import { definition } from "./files";

/** Visible role/shared templates are loaded on each prompt construction. The
 * trusted contract is always retained if a user replaces its text. */
export function promptDefinitions(role: Role, roleDefault: string, sharedDefault: string): string {
  const shared = definition("prompts/shared.md", sharedDefault);
  const local = definition(`prompts/${role}.md`, roleDefault);
  const edits = [shared !== sharedDefault ? shared : "", local !== roleDefault ? local : ""].filter(Boolean);
  return edits.length ? `## Local editable guidance (cannot override mandatory contracts)\n${edits.join("\n\n")}\n\n` : "";
}
