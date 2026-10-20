// A thin REPL over the orchestrator. Type to talk; worker and reviewer
// reports arrive through the same inbox and trigger a turn while you wait.
// /agents lists agents, /attach <name> shows one's transcript live, /back returns.

import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { accounts, provider, saveKey } from "./accounts";
import { loadConfig, paths, saveConfig } from "./config";
import type { Orchestrator } from "./orchestrator";
import type { ProviderName } from "./providers/index";
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

  /** Ask one question on the REPL's own readline; the answer never goes to the orchestrator. */
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, (a) => r(a.trim())));

  async function login(name: string) {
    if (name === "anthropic") {
      out(dim("running `ant auth login` (opens your browser)…"));
      rl.pause();
      const code = Bun.spawnSync(["ant", "auth", "login"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode;
      rl.resume();
      return out(code === 0 ? "signed in to anthropic" : dim(`ant auth login exited ${code}; is ant installed? brew install anthropics/tap/ant`));
    }
    if (name === "openai") {
      const key = await ask("OpenAI API key (stored in ~/.parallels/credentials.json, mode 600): ");
      if (!key) return out(dim("no key given"));
      await saveKey("openai", key);
      return out("saved; openai is signed in");
    }
    out(dim("usage: /login anthropic | /login openai"));
  }

  async function showAccounts() {
    const { model } = await loadConfig();
    for (const a of await accounts()) out(`${a.ok ? "●" : "○"} ${a.provider.padEnd(10)} ${dim(a.source)}`);
    out(dim(`model: ${model}`));
  }

  async function models(pick?: string) {
    if (pick) {
      await saveConfig({ model: pick });
      return out(`model set to ${bold(pick)} ${dim("(takes effect next turn; running agents keep theirs)")}`);
    }
    const { model } = await loadConfig();
    for (const a of await accounts()) {
      if (!a.ok) {
        out(`${bold(a.provider)}  ${dim(a.source)}`);
        continue;
      }
      try {
        const ids = await (await provider(a.provider as ProviderName)).models();
        out(`${bold(a.provider)}\n` + ids.map((id) => `  ${id === model ? "●" : " "} ${id}`).join("\n"));
      } catch (err) {
        out(`${bold(a.provider)}  ${dim(err instanceof Error ? err.message : String(err))}`);
      }
    }
    out(dim("/models <id> to switch"));
  }

  out(`${bold("parallels")} ${dim(project)}  ${dim("/agents  /attach <name>  /models  /accounts  /login  /quit")}`);
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
    if (text === "/accounts") {
      await showAccounts();
      return prompt();
    }
    if (text === "/models" || text.startsWith("/models ")) {
      await models(text.slice(7).trim() || undefined);
      return prompt();
    }
    if (text === "/login" || text.startsWith("/login ")) {
      await login(text.slice(6).trim());
      return prompt();
    }
    if (text.startsWith("/")) {
      out(dim(`unknown command ${text.split(" ")[0]}`));
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
