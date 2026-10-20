// A thin REPL over the orchestrator. Type to talk; worker and reviewer
// reports arrive through the same inbox and trigger a turn while you wait.
// /agents, /accounts and /models open arrow-key menus; /attach <name> shows a transcript live, /back returns.

import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { accounts, provider } from "./accounts";
import { importClaudeCode, loginClaude } from "./claude-auth";
import { importCodex, loginCodex } from "./codex-auth";
import { loadConfig, paths, saveConfig } from "./config";
import type { Orchestrator } from "./orchestrator";
import { bold, dim, pick } from "./picker";
import type { ProviderName } from "./providers/index";
import { sessionName, tmux } from "./runner";
import { follow } from "./view";

/** How many of each provider's newest models /models offers. */
export const RECENT_MODELS = 6;

/** The newest `limit` ids, keeping `current` in the list even when it is older. */
export function recentModels(ids: string[], current: string, limit = RECENT_MODELS): string[] {
  const head = ids.slice(0, limit);
  return ids.includes(current) && !head.includes(current) ? [...head, current] : head;
}

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

  async function login(arg: string) {
    const [alias, ...args] = arg.split(/\s+/);
    const name = alias === "claude" ? "anthropic" : alias === "codex" ? "openai" : alias;
    if (name === "anthropic" || name === "openai") {
      const importFlag = name === "anthropic" ? "--from-claude-code" : "--from-codex";
      const names = args.filter((a) => a !== importFlag);
      if (names.length > 1 || names.some((n) => n.startsWith("--"))) return out(dim(`usage: /login ${name} [profile] [${importFlag}]`));
      const profile = names[0] ?? "default";
      if (args.includes(importFlag)) await (name === "anthropic" ? importClaudeCode : importCodex)(profile);
      else await (name === "anthropic" ? loginClaude : loginCodex)(profile, { write: out, signal: loginAbort.signal });
      await saveConfig(name === "anthropic" ? { account: profile } : { openaiAccount: profile });
      return out(`signed in; now using ${name}:${profile} (${name === "anthropic" ? "Claude Code / Claude subscription" : "Codex / ChatGPT subscription"})`);
    }
    out(dim("usage: /login anthropic [profile] [--from-claude-code]  |  /login openai [profile] [--from-codex]"));
  }

  /** Arrow keys choose an account: a signed-in one becomes active, any other starts /login. */
  async function showAccounts() {
    const { model } = await loadConfig();
    const list = await accounts();
    const picked = await pick(
      list.map((a) => ({ value: a, current: a.active, label: `${a.ok ? "○" : "✗"} ${a.id.padEnd(22)} ${dim(a.source)}` })),
      { title: dim(`model: ${model}   ↑↓ then Enter to use an account or sign in; Esc to cancel`) },
    );
    if (!picked) return;
    if (picked.ok) return use(picked.id);
    loggingIn = true;
    try { await login(`${picked.provider} ${picked.id.split(":")[1]}`); }
    catch (err) { out(`login failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { loggingIn = false; }
  }

  async function use(id: string) {
    const normalized = id.replace(/^claude:/, "anthropic:").replace(/^codex:/, "openai:");
    const target = normalized.includes(":") ? normalized : `anthropic:${normalized}`;
    const account = (await accounts()).find((a) => a.id === target && a.ok);
    if (!account) return out(dim("no such subscription account; try /accounts or /login"));
    const profile = account.id.split(":")[1]!;
    await saveConfig(account.provider === "anthropic" ? { account: profile } : { openaiAccount: profile });
    out(`using ${account.id} ${dim("(takes effect next turn; running agents keep theirs)")}`);
  }

  async function models(id?: string) {
    if (id) {
      await saveConfig({ model: id });
      return out(`model set to ${bold(id)} ${dim("(takes effect next turn; running agents keep theirs)")}`);
    }
    const { model } = await loadConfig();
    const choices: { value: string; label: string; current?: boolean }[] = [];
    for (const a of await accounts()) {
      if (!a.active) continue;
      try {
        const ids = await (await provider(a.provider as ProviderName)).models();
        for (const id of recentModels(ids, model)) choices.push({ value: id, current: id === model, label: `${id}  ${dim(a.provider)}` });
      } catch (err) {
        out(`${bold(a.provider)}  ${dim(err instanceof Error ? err.message : String(err))}`);
      }
    }
    if (!choices.length) return out(dim("no models available; sign in with /login first"));
    const picked = await pick(choices, { title: dim("↑↓ then Enter to switch model; Esc to cancel   (/models <id> for any other id)") });
    if (picked && picked !== model) await models(picked);
  }

  /** Arrow keys choose an agent to attach to. */
  async function showAgents() {
    const agents = await listAgents(project);
    if (!agents.length) return out(dim("no agents yet"));
    const picked = await pick(
      agents.map((a) => ({ value: a.name, label: `${a.name}  ${dim(a.live ? "live" : "finished")}` })),
      { title: dim("↑↓ then Enter to attach; Esc to cancel") },
    );
    if (picked) await attach(picked);
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
      await showAgents();
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
