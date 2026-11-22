import { errorMessage } from "../../../../config";
import { GUARD, type GuardInput, type GuardRule } from "./rules";
import { SECRET_REASON, SECRET_SUGGESTION } from "./secret";
import { commands } from "./shell";

export type Refusal = { id: string; text: string };

export const SECRET_REFUSAL: Refusal = { id: "secret-file", text: `refused (secret-file): ${SECRET_REASON}. Use: ${SECRET_SUGGESTION}` };

export function refusal(extra: GuardRule[], input: Record<string, unknown>, root: string): Refusal | null {
  if (typeof input.command !== "string") return null;
  const checked: GuardInput[] = commands(input.command, root).map(command => ({ tool: "bash", input, command, root }));
  for (const rule of [...GUARD, ...extra]) {
    for (const call of checked) {
      try {
        if (rule.test(call)) return { id: rule.id, text: `refused (${rule.id}): ${rule.reason}. Use: ${rule.suggest(call)}` };
      } catch (error) {
        return { id: rule.id, text: `refused (${rule.id}): the rule failed (${errorMessage(error)})` };
      }
    }
  }
  return null;
}
