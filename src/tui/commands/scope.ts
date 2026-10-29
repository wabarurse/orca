// The scope step: which agents a change applies to. /model opens it first; /effort and /fast can adopt it the same way
// (their own `describe` and `then`), without changing this file.

import type { Role } from "../../protocol";
import type { Choice } from "./model";

/** "all": every agent of the project (the project-wide value); a role: only that role's agents. */
export type Scope = "all" | Role;
export const SCOPES: readonly Scope[] = ["all", "orchestrator", "worker", "reviewer"];
export const scopeNames: Readonly<Record<Scope, string>> = { all: "all agents", orchestrator: "orchestrator", worker: "workers", reviewer: "reviewers" };
const ALIASES: Readonly<Record<string, Scope>> = {
  all: "all", orch: "orchestrator", orchestrator: "orchestrator", worker: "worker", workers: "worker", reviewer: "reviewer", reviewers: "reviewer",
};

/** A scope argument (`orch`, `worker(s)`, `reviewer(s)`, `orchestrator`, `all`), or undefined for anything else. */
export function parseScope(arg: string): Scope | undefined {
  return Object.hasOwn(ALIASES, arg.trim().toLowerCase()) ? ALIASES[arg.trim().toLowerCase()] : undefined;
}

export const scopeUsage = (command: string) => `usage: ${command} [orch|worker|reviewer]   (no argument: choose all agents or one role)`;

/** The scope rows, in SCOPES order: each scope's name, then what it has now (`describe`). No row is "current": the first is the default. */
export function scopeChoices(describe: (scope: Scope) => string): Choice<Scope>[] {
  const width = Math.max(...SCOPES.map((scope) => scopeNames[scope].length));
  return SCOPES.map((scope) => ({ value: scope, label: `${scopeNames[scope].padEnd(width)}  ${describe(scope)}` }));
}

export interface ScopeStep {
  /** The command, for the usage line (e.g. "/model"). */
  command: string;
  /** The scope menu's title. */
  title: string;
  /** What `scope` has now, shown on its row. */
  describe(scope: Scope): string;
  open(title: string, choices: Choice<Scope>[], pick: (scope: Scope) => Promise<void> | void): void;
  note(text: string): void;
  /** The command's next step for the chosen scope. */
  then(scope: Scope): Promise<void> | void;
}

/** `arg` names a scope: straight to `then` (the fast path); empty: the scope menu; anything else: the usage, nothing opens. */
export function chooseScope(arg: string, step: ScopeStep): Promise<void> | void {
  if (arg.trim()) {
    const scope = parseScope(arg);
    return scope ? step.then(scope) : step.note(scopeUsage(step.command));
  }
  step.open(step.title, scopeChoices(step.describe), (scope) => step.then(scope));
}
