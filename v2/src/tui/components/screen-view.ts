export type OpenTab = string;

export type ScreenItem =
  | { kind: "rows"; key: string; gap: boolean; rows: string[] }
  | { kind: "user"; key: string; gap: boolean; rows: string[]; fill: string | null; open: boolean; more: number }
  | { kind: "fold"; key: string; gap: boolean; title: string; failed: string; open: boolean; rows: string[]; opens: OpenTab | null };

export type ScreenTab = { label: string; active: boolean; busy: boolean };

export const FIN_COLS = 32, FIN_MIN_COLS = 72, FIN_ROWS = 5;

export type ScreenHeader = {
  tabs: ScreenTab[];
  bubble: string | null;
  account: string | null;
  details: string[];
  fin: { time: number; active: boolean } | null;
};

export type ChatScreen = {
  kind: "chat";
  header: ScreenHeader | null;
  view: string;
  items: ScreenItem[];
  tail: string[];
  welcome: string[];
  footer: string[];
  cursor: { row: number; col: number } | null;
};

export type PageScreen = { kind: "page"; rows: string[]; cursor: number; col: number };

export type Screen = ChatScreen | PageScreen;

export type ScreenAction =
  | { kind: "toggle"; key: string }
  | { kind: "open"; tab: OpenTab; index: number }
  | { kind: "link"; url: string }
  | { kind: "copy"; text: string }
  | { kind: "input"; phase: "down" | "drag" | "up"; row: number; col: number };
