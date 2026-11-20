// What the TUI shows, as data: App builds one of these per frame and the terminal (tui/otui) turns it into
// OpenTUI renderables. Rows here are already styled text (SGR and OSC 8), laid out at the width they are shown at.

/** A work-page tab a conversation item can open ("● <item>  open"). */
export type OpenTab = "questions" | "images" | "agents" | "tasks";

/** One item of the conversation. `key` is stable across frames for the same item; `gap` puts a blank row above it. */
export type ScreenItem =
  /** Text as laid-out rows: markdown, a tool call, a note. */
  | { kind: "rows"; key: string; gap: boolean; rows: string[] }
  /** The user's own message: a block on the right shaded with `fill` (the user background's SGR), or a plain grey without one. */
  | { kind: "user"; key: string; gap: boolean; rows: string[]; fill: string | null }
  /** A fold: ▸ title (and a red `failed` note), open shows `rows` under it; `opens` names the tab each row's "open" goes to. */
  | { kind: "fold"; key: string; gap: boolean; title: string; failed: string; open: boolean; rows: string[]; opens: OpenTab | null };

export type ScreenTab = { label: string; active: boolean; busy: boolean };

/** The orca fin beside the header's details: its width, the narrowest screen that has room for it, and its height. */
export const FIN_COLS = 32, FIN_MIN_COLS = 72, FIN_ROWS = 5;

export type ScreenHeader = {
  tabs: ScreenTab[];
  /** The bubble the conversation belongs to, its own row above the account; null when it has none. */
  bubble: string | null;
  /** The project's account, its own row; null while unknown. */
  account: string | null;
  /** Each role's model and settings (one row when they agree), the context label on the first. */
  details: string[];
  /** The orca fin beside the details: swimming while the conversation works. */
  fin: { time: number; active: boolean } | null;
};

/** The chat screen: header, conversation, the live tail, and the composer region (input, counts, menus, help) as rows. */
export type ChatScreen = {
  kind: "chat";
  header: ScreenHeader | null;
  items: ScreenItem[];
  /** The streaming reply, running calls and the activity line, after the conversation. */
  tail: string[];
  /** The orca drawn in an empty new chat, centred in the conversation. */
  welcome: string[];
  /** Rows under the conversation: notes, queued input, the boxed composer with its counts, then a menu or help. */
  footer: string[];
  /** The cursor inside `footer` (row and column, zero-based), or null to hide it. */
  cursor: { row: number; col: number } | null;
};

/** A full-screen page (the work page): its rows and cursor. */
export type PageScreen = { kind: "page"; rows: string[]; cursor: number; col: number };

export type Screen = ChatScreen | PageScreen;

/** What a click on the screen asks the app for. */
export type ScreenAction =
  | { kind: "toggle"; key: string }
  | { kind: "open"; tab: OpenTab; index: number }
  | { kind: "link"; url: string }
  | { kind: "copy"; text: string };
