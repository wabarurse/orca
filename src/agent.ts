// The agent loop. Orchestrator, worker and reviewer are all this function with
// a different role, system prompt and tool set.

import type { Role } from "./transcript";

export interface AgentOptions {
  project: string;
  role: Role;
  taskId?: string;
  /** Transcript id; a new one is created when omitted. */
  session?: string;
}

// TODO(PR2): open the transcript, load the prompt for the role, then loop:
// send chain() to the API, stream text to stdout, run tool calls through the
// registry, append results, stop when the model ends its turn with no tool use.
export async function runAgent(_opts: AgentOptions): Promise<void> {
  throw new Error("agent: not implemented");
}
