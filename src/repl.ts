// A thin REPL over the orchestrator. Type to talk; worker and reviewer
// reports arrive through the same inbox and trigger a turn while you wait.
// /agents lists the live agent windows, /attach <name> drops you into one.

import { createInterface } from "node:readline";
import type { Orchestrator } from "./orchestrator";
import { sessionName, tmux } from "./runner";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

export async function listAgents(project: string): Promise<string[]> {
  return (await tmux.listWindows(sessionName(project))).filter((w) => w !== "shell");
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

  out(`${bold("parallels")} ${dim(project)}  ${dim("/agents  /attach <name>  /quit")}`);
  rl.setPrompt(dim("> "));
  prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (text === "/quit") return rl.close();
    if (text === "/agents") {
      const agents = await listAgents(project);
      out(agents.length ? agents.join("\n") : dim("no live agents"));
      return prompt();
    }
    if (text.startsWith("/attach ")) {
      const name = text.slice(8).trim();
      rl.pause();
      const code = tmux.attach(sessionName(project), name);
      rl.resume();
      if (code !== 0) out(dim(`no agent window "${name}"; try /agents`));
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
