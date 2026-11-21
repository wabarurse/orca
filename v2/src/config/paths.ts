// Where orca2 keeps everything: one home, ~/.orca2 (ORCA2_HOME in tests), separate from v1's ~/.orca.
import { homedir } from "node:os";
import { join } from "node:path";

const root = (): string => process.env.ORCA2_HOME ?? join(homedir(), ".orca2");
const conversation = (id: string): string => join(root(), "conversations", id);

export const paths = {
  get root(): string { return root(); },
  /** The user's settings: model, accounts, default plugins, trusted folders. */
  get config(): string { return join(root(), "config.toml"); },
  /** Sign-in tokens, the rate-limit cooldown database, the login URL. Never shown to agents. */
  get runtime(): string { return join(root(), ".runtime"); },
  get memory(): string { return join(root(), ".runtime", "state.sqlite"); },
  get usage(): string { return join(root(), "usage.jsonl"); },
  /** Archived messages, searched by the memory tool. */
  get archive(): string { return join(root(), "archive.sqlite"); },
  get mcp(): string { return join(root(), "mcp.json"); },
  get plugins(): string { return join(root(), "plugins"); },
  get skills(): string { return join(root(), "skills"); },
  /** Global plugin data, `$ORCA_DATA/global/<plugin>`. */
  get globalData(): string { return join(root(), "global"); },
  get bubbles(): string { return join(root(), "bubbles"); },
  bubble: (id: string): string => join(root(), "bubbles", id),
  bubbleData: (id: string): string => join(root(), "bubbles", id, "data"),
  get conversations(): string { return join(root(), "conversations"); },
  conversation,
  meta: (id: string): string => join(conversation(id), "meta.json"),
  transcript: (id: string, agent: string): string => join(conversation(id), "transcript", `${agent}.jsonl`),
  inbox: (id: string, agent: string): string => join(conversation(id), "inbox", agent),
  inboxes: (id: string): string => join(conversation(id), "inbox"),
  runs: (id: string): string => join(conversation(id), "runs"),
  logs: (id: string): string => join(conversation(id), "logs"),
  daemon: (id: string): string => join(conversation(id), "daemon"),
  images: (id: string): string => join(conversation(id), "images"),
  /** `$ORCA_DATA` for this conversation's agents: `<plugin>/`, plus the `bubble` and `global` links. */
  data: (id: string): string => join(conversation(id), "data"),
  worktree: (id: string, slug: string): string => join(root(), "worktrees", id, slug),
  worktrees: (id: string): string => join(root(), "worktrees", id),
};
