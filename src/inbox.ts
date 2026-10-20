// One file per message in paths.inbox(project). The orchestrator drains it
// between turns. Every client (terminal, worker, reviewer, Instinct in M3)
// goes through here, so there is one code path.

export interface Message {
  from: string;
  text: string;
  ts: string;
}

// TODO(PR5): put() writes `<ts>-<from>.json`; drain() reads and deletes all,
// oldest first.
export async function put(_project: string, _msg: Omit<Message, "ts">): Promise<void> {
  throw new Error("inbox: not implemented");
}

export async function drain(_project: string): Promise<Message[]> {
  throw new Error("inbox: not implemented");
}
