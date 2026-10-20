// A thin REPL over the orchestrator. Type to talk; worker and reviewer
// reports arrive through the same inbox and trigger a turn while you wait.
// /agents lists agents, /attach <name> shows one's transcript live, /back returns.

import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { accounts, anthropicProfiles, provider, saveKey } from "./accounts";
import { importClaudeCode, loginClaude } from "./claude-auth";
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
  let loggingIn = false;
  const loginAbort = new AbortController();
  // Set while /attach is showing a transcript; calling it returns to the orchestrator.
  const view: { leave: (() => void) | null } = { leave: null };
  rl.on("close", () => { closed = true; loginAbort.abort(); });
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

  async function login(arg: string) {
    const [name, ...args] = arg.split(/\s+/);
    if (name === "anthropic") {
      const names = args.filter((a) => a !== "--from-claude-code");
      if (names.length > 1 || names.some((n) => n.startsWith("--"))) return out(dim("usage: /login anthropic [profile] [--from-claude-code]"));
      const profile = names[0] ?? "default";
      if (args.includes("--from-claude-code")) await importClaudeCode(profile);
      else await loginClaude(profile, { write: out, signal: loginAbort.signal });
      await saveConfig({ account: profile });
      return out(process.env.ANTHROPIC_API_KEY
        ? `saved anthropic:${profile}; ANTHROPIC_API_KEY still overrides it with API billing. Unset it to use your subscription.`
        : `signed in; now using anthropic:${profile} (Claude subscription)`);
    }
    if (name === "openai") {
      const key = await ask("OpenAI API key (stored in ~/.parallels/credentials.json, mode 600): ");
      if (!key) return out(dim("no key given"));
      await saveKey("openai", key);
      return out("saved; openai is signed in");
    }
    out(dim("usage: /login anthropic [profile] [--from-claude-code]  |  /login openai"));
  }

  async function showAccounts() {
    const { model } = await loadConfig();
    for (const a of await accounts()) out(`${a.active ? "●" : a.ok ? "○" : "✗"} ${a.id.padEnd(22)} ${dim(a.source)}`);
    out(dim(`model: ${model}   /use <account> to switch where tokens come from`));
  }

  async function use(id: string) {
    const profile = id.replace(/^anthropic:/, "");
    if (!profile || !anthropicProfiles().includes(profile)) {
      return out(dim(`no such account; anthropic profiles: ${anthropicProfiles().join(", ") || "none"}. /login anthropic <name> adds one`));
    }
    await saveConfig({ account: profile });
    out(process.env.ANTHROPIC_API_KEY
      ? `selected anthropic:${profile}; unset ANTHROPIC_API_KEY to use the subscription instead of API billing.`
      : `using anthropic:${profile} ${dim("(takes effect next turn; running agents keep theirs)")}`);
  }

  async function models(pick?: string) {
    if (pick) {
      await saveConfig({ model: pick });
      return out(`model set to ${bold(pick)} ${dim("(takes effect next turn; running agents keep theirs)")}`);
    }
    const { model } = await loadConfig();
    for (const a of await accounts()) {
      if (!a.active) continue;
      try {
        const ids = await (await provider(a.provider as ProviderName)).models();
        out(`${bold(a.provider)}\n` + ids.map((id) => `  ${id === model ? "●" : " "} ${id}`).join("\n"));
      } catch (err) {
        out(`${bold(a.provider)}  ${dim(err instanceof Error ? err.message : String(err))}`);
      }
    }
    out(dim("/models <id> to switch"));
  }

  out(`${bold("parallels")} ${dim(project)}  ${dim("/agents  /attach <name>  /models  /accounts  /use  /login  /quit")}`);
  rl.setPrompt(dim("> "));
  prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (loggingIn) {
      if (text === "/quit") rl.close();
      return;
    }
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
    if (text.startsWith("/use ")) {
      await use(text.slice(5).trim());
      return prompt();
    }
    if (text === "/login" || text.startsWith("/login ")) {
      loggingIn = true;
      try { await login(text.slice(6).trim()); }
      catch (err) { out(`login failed: ${err instanceof Error ? err.message : String(err)}`); }
      finally { loggingIn = false; }
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
    if (!busy && !loggingIn && (await orch.pending())) await runTurn();
  }, 2000);

  await new Promise<void>((resolve) => rl.on("close", resolve));
  if (view.leave) view.leave();
  clearInterval(poll);
}
