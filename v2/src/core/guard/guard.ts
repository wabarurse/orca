import { errorMessage } from "../../config";
import { GUARD, type GuardInput, type GuardRule } from "./rules";
import { commands } from "./shell";

export type Refusal = { id: string; text: string };

function calls(tool: string, input: Record<string, unknown>, root: string): GuardInput[] {
  if (tool !== "bash" || typeof input.command !== "string") return [{ tool, input, command: null, root }];
  return commands(input.command, root).map(command => ({ tool, input, command, root }));
}

export function refusal(extra: GuardRule[], tool: string, input: Record<string, unknown>, root: string): Refusal | null {
  const checked = calls(tool, input, root);
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
