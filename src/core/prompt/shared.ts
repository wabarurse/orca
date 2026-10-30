import { promptDefinitions } from "../definitions";
import type { Role } from "../../protocol";
import { ORCHESTRATOR } from "./orchestrator";
import { REVIEWER } from "./reviewer";
import { WORKER } from "./worker";

const TERMINOLOGY = "Use the user’s terminology for concepts and features. If an internal term differs, explain the distinction rather than silently substituting it.";
const templates: Record<Role, string> = { orchestrator: ORCHESTRATOR, worker: WORKER, reviewer: REVIEWER };

// Like Pi's customizable system prompt, workflow instructions belong in the
// selected prompt rather than runtime dispatch switches or numeric review loops.
// https://github.com/earendil-works/pi/blob/a14cdf90f0a76532f3e20bc3c01872837cef24ba/packages/coding-agent/src/core/system-prompt.ts
export function rolePrompt(role: Role): string {
  return `${promptDefinitions(role, templates[role], TERMINOLOGY)}${templates[role]}\n\n${TERMINOLOGY}`;
}
