// A thin REPL over the orchestrator. Type to talk; worker and reviewer
// reports arrive through the same inbox and trigger a turn while you wait.
// /agents lists agents, /attach <name> shows one's transcript live, /back returns.

import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { paths } from "./config";
import type { Orchestrator } from "./orchestrator";
import { sessionName, tmux } from "./runner";
import { follow } from "./view";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** Every agent that has a transcript, marked live when its tmux window is still open. */
export async function listAgents(project: string): Promise<{ name: string; live: boolean }[]> {
  const live = new Set(await tmux.listWindows(sessionName(project)).catch(() => []));
  const dir = paths.transcript(project, "x").replace(/x\.jsonl$/, "");
  const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
  return names.filter((n) => n !== "orchestrator").map((name) => ({ name, live: live.has(name) }));
}

export async function repl(project: string, orch: Orchestrator): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const out = (s: string) => process.stdout.write(s + "\n");
  let busy = false;
  let closed = false;
  // Set while /attach is showing a transcript; calling it returns to the orchestrator.
  const view: { leave: (() => void) | null } = { leave: null };
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
      if (!view.leave) prompt();
    }
  }

  async function attach(name: string) {
    // Enter view mode before any await so a quick /back can't reach the orchestrator.
    const stopped = new Promise<void>((r) => (view.leave = r));
    try {
      const agent = (await listAgents(project)).find((a) => a.name === name);
      if (!agent) return out(dim(`no agent "${name}"; try /agents`));
      out(`${bold(name)} ${dim(agent.live ? "live" : "finished")}  ${dim("/back to return")}`);
      rl.setPrompt(dim(`${name} > `));
      // Clear the prompt line, print the entry, redraw the prompt so it's clear you can type.
      const show = (s: string) => {
        process.stdout.write(`\x1b[2K\r${s}\n`);
        prompt();
      };
      await follow(paths.transcript(project, name), show, stopped);
      out(dim("— back to orchestrator"));
    } finally {
      view.leave = null;
      rl.setPrompt(dim("> "));
    }
  }

  out(`${bold("parallels")} ${dim(project)}  ${dim("/agents  /attach <name>  /quit")}`);
  rl.setPrompt(dim("> "));
  prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (view.leave) {
      if (text === "/back" || text === "/quit") view.leave();
      if (text === "/quit") rl.close();
      return;
    }
    if (text === "/quit") return rl.close();
    if (text === "/agents") {
      const agents = await listAgents(project);
      out(agents.length ? agents.map((a) => `${a.name}  ${dim(a.live ? "live" : "finished")}`).join("\n") : dim("no agents yet"));
      return prompt();
    }
    if (text.startsWith("/attach ")) {
      await attach(text.slice(8).trim());
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
  if (view.leave) view.leave();
  clearInterval(poll);
}
