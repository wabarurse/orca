// A thin REPL over the orchestrator. Type to talk; worker and reviewer
// reports arrive through the same inbox and trigger a turn while you wait.

import { createInterface } from "node:readline";
import type { Orchestrator } from "./orchestrator";
import { readTasks } from "./tasks";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

export async function tasksTable(project: string): Promise<string> {
  const tasks = await readTasks(project);
  if (tasks.length === 0) return dim("no tasks yet");
  const rows = tasks.map((t) => [t.id, t.status, t.branch, t.desc.split("\n")[0] ?? ""]);
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i]!.length), 2));
  return rows.map((r) => r.map((c, i) => (i < 3 ? c.padEnd(widths[i]!) : c)).join("  ")).join("\n");
}

export async function repl(project: string, orch: Orchestrator): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const out = (s: string) => process.stdout.write(s + "\n");
  let busy = false;
  let closed = false;
  rl.on("close", () => (closed = true));
  const prompt = () => {
    if (!closed) rl.prompt();
  };

  async function runTurn() {
    if (busy) return;
    busy = true;
    try {
      for (const reply of await orch.turn()) out(`\n${bold(reply.from)} ${reply.text}`);
    } catch (err) {
      out(`\n${bold("error")} ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
      prompt();
    }
  }

  out(`${bold("parallels")} ${dim(project)}  ${dim("/tasks  /quit")}`);
  rl.setPrompt(dim("> "));
  prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (text === "/quit") return rl.close();
    if (text === "/tasks") {
      out(await tasksTable(project));
      return prompt();
    }
    if (!text) return prompt();
    await orch.say(text);
    await runTurn();
  });

  // Worker and reviewer reports land in the inbox while we wait for input.
  const poll = setInterval(async () => {
    if (!busy && (await orch.pending())) await runTurn();
  }, 2000);

  await new Promise<void>((resolve) => rl.on("close", resolve));
  clearInterval(poll);
}
