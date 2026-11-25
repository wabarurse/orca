export const CHANNELS = ["auto", "iterm2", "iterm2_with_bell", "terminal_bell", "kitty", "ghostty", "notifications_disabled"] as const;
export type ChannelSetting = (typeof CHANNELS)[number];
export type Channel = Exclude<ChannelSetting, "auto">;
export type Env = Record<string, string | undefined>;

export type StatusKind = "permission" | "question" | "auth";
export type ProgramStatus =
  | { state: "idle" | "done" | "error"; title: string | null; msg: string | null }
  | { state: "working"; title: string | null; msg: string | null; progress: number | null }
  | { state: "blocked"; title: string | null; msg: string | null; kind: StatusKind | null; progress: number | null }
  | { state: "clear" };

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;
const APP = "orca2";
const TITLE_BYTES = 192;
const MSG_BYTES = 2048;
const BODY_CHARS = 200;

const set = (env: Env, name: string): boolean => (env[name] ?? "") !== "";

export const isChannelSetting = (value: string): value is ChannelSetting => CHANNELS.some(c => c === value);

export function inRex(env: Env): boolean {
  return set(env, "REX_SESSION") || env.TERM_PROGRAM === "rex";
}

export function autoChannel(env: Env): Channel {
  const program = env.TERM_PROGRAM ?? "", term = env.TERM ?? "";
  if (inRex(env)) return "ghostty";
  if (program === "iTerm.app" || env.LC_TERMINAL === "iTerm2" || set(env, "ITERM_SESSION_ID")) return "iterm2";
  if (program === "kitty" || term === "xterm-kitty" || set(env, "KITTY_WINDOW_ID")) return "kitty";
  if (program === "ghostty" || term === "xterm-ghostty" || set(env, "GHOSTTY_RESOURCES_DIR")) return "ghostty";
  if (program === "WezTerm" || set(env, "WEZTERM_PANE")) return "iterm2";
  return "terminal_bell";
}

export function notifyChannel(setting: ChannelSetting, env: Env): Channel {
  return setting === "auto" ? autoChannel(env) : setting;
}

export function plainLine(text: string, max: number): string {
  const flat = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

const osc = (body: string, end: string = BEL): string => `${ESC}]${body}${end}`;

export function passthrough(sequence: string, env: Env): string {
  if (!set(env, "TMUX")) return sequence;
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ST}`;
}

export function notification(channel: Channel, title: string, body: string, id: number): string[] {
  const head = plainLine(title, 60).replaceAll(";", ",");
  const text = plainLine(body, BODY_CHARS);
  switch (channel) {
    case "iterm2": return [osc(`9;${head}: ${text}`)];
    case "iterm2_with_bell": return [osc(`9;${head}: ${text}`), BEL];
    case "kitty": return [osc(`99;i=${id}:d=0:p=title;${head}`, ST), osc(`99;i=${id}:p=body;${text}`, ST), osc(`99;i=${id}:d=1:a=focus;`, ST)];
    case "ghostty": return [osc(`777;notify;${head};${text}`)];
    case "terminal_bell": return [BEL];
    case "notifications_disabled": return [];
  }
}

function clipBytes(text: string, max: number): string {
  const encoder = new TextEncoder();
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (used + size > max) break;
    out += char;
    used += size;
  }
  return out;
}

const b64 = (text: string, max: number): string => Buffer.from(clipBytes(plainLine(text, max), max)).toString("base64");

export function programStatus(status: ProgramStatus): string {
  if (status.state === "clear") return osc("7501;state=clear");
  const fields = [`state=${status.state}`, `app=${APP}`];
  if (status.state === "blocked" && status.kind !== null) fields.push(`kind=${status.kind}`);
  if ((status.state === "working" || status.state === "blocked") && status.progress !== null && Number.isFinite(status.progress)) fields.push(`progress=${Math.min(100, Math.max(0, Math.round(status.progress)))}`);
  if (status.title !== null && status.title.length > 0) fields.push(`title=${b64(status.title, TITLE_BYTES)}`);
  if (status.msg !== null && status.msg.length > 0) fields.push(`msg=${b64(status.msg, MSG_BYTES)}`);
  return osc(`7501;${fields.join(":")}`);
}

export function progress(busy: boolean): string {
  return osc(busy ? "9;4;3;" : "9;4;0;");
}

const version = (text: string): number[] => text.split(/[.-]/).slice(0, 3).map(part => Number.parseInt(part, 10)).map(n => Number.isFinite(n) ? n : 0);

function atLeast(have: string, want: string): boolean {
  const a = version(have), b = version(want);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export function reportsProgress(env: Env): boolean {
  if (set(env, "WT_SESSION")) return false;
  if (inRex(env)) return true;
  if (set(env, "ConEmuANSI") || set(env, "ConEmuPID") || set(env, "ConEmuTask")) return true;
  const program = env.TERM_PROGRAM ?? "", at = env.TERM_PROGRAM_VERSION ?? "";
  if (at.length === 0) return false;
  if (program === "ghostty") return atLeast(at, "1.2.0");
  if (program === "iTerm.app") return atLeast(at, "3.6.6");
  return false;
}
