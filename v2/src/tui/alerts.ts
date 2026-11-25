import { inRex, isChannelSetting, notification, notifyChannel, passthrough, plainLine, programStatus, progress, reportsProgress, type ChannelSetting, type Env, type ProgramStatus } from "./components";

export type AlertTerminal = { signal: (sequence: string) => boolean; answersStatus: () => boolean };
export type Chat = { id: string; name: string };
export type ChatTurn = Chat & { busy: boolean; error: string | null; gist: string };
export type Notice = { id: string; from: string; text: string };

type Outcome = "idle" | "done" | "error";
type Seen = { busy: boolean; outcome: Outcome; gist: string; name: string };

const TITLE = "orca2";
const GIST = 120;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export class Alerts {
  private enabled = true;
  private channel: ChannelSetting = "auto";
  private readonly turns = new Map<string, Seen>();
  private readonly asked = new Map<string, { name: string; count: number }>();
  private readonly seenNotices = new Map<string, Set<string>>();
  private current: Chat | null = null;
  private sentStatus: string | null = null;
  private sentProgress = false;

  constructor(private readonly terminal: AlertTerminal, private readonly env: Env, private readonly pick: () => number = () => Math.floor(Math.random() * 10000)) {}

  configure(enabled: boolean, channel: string): void {
    this.channel = isChannelSetting(channel) ? channel : "auto";
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.leave(); else this.refresh();
  }

  focus(chat: Chat): void {
    this.current = chat;
    this.refresh();
  }

  turn(chat: ChatTurn): void {
    const before = this.turns.get(chat.id) ?? null;
    const gist = chat.gist.length > 0 ? chat.gist : before?.gist ?? "";
    const ended = before !== null && before.busy && !chat.busy;
    const outcome: Outcome = ended ? chat.error !== null ? "error" : "done" : before?.outcome ?? "idle";
    this.turns.set(chat.id, { busy: chat.busy, outcome, gist, name: chat.name });
    if (ended) this.notify(chat.error !== null ? `${chat.name}: turn failed: ${chat.error}` : `${chat.name}: ${gist.length > 0 ? gist : "reply ready"}`);
    this.refresh();
  }

  questions(chat: Chat, count: number | null): void {
    if (count === null) return;
    const before = this.asked.get(chat.id) ?? null;
    this.asked.set(chat.id, { name: chat.name, count });
    if (before !== null && count > before.count) this.notify(`${chat.name}: ${plural(count, "question")} waiting for you`);
    this.refresh();
  }

  notices(chat: Chat, notices: Notice[]): void {
    const seen = this.seenNotices.get(chat.id) ?? null;
    if (seen === null) { this.seenNotices.set(chat.id, new Set(notices.map(n => n.id))); return; }
    for (const notice of notices) {
      if (seen.has(notice.id)) continue;
      seen.add(notice.id);
      this.notify(`${chat.name}: ${notice.from}: ${notice.text}`);
    }
  }

  leave(): void {
    if (this.sentStatus !== null) this.send(programStatus({ state: "clear" }));
    if (this.sentProgress) this.send(progress(false));
    this.sentStatus = null;
    this.sentProgress = false;
  }

  status(): ProgramStatus {
    const title = this.current === null ? TITLE : `${TITLE} · ${this.current.name}`;
    const waiting = [...this.asked.values()].filter(a => a.count > 0);
    const total = waiting.reduce((sum, a) => sum + a.count, 0);
    if (total > 0) return { state: "blocked", kind: "question", progress: null, title, msg: `${plural(total, "question")} waiting · ${waiting.map(a => a.name).join(", ")}` };
    const busy = [...this.turns.values()].filter(t => t.busy);
    if (busy.length > 0) return { state: "working", progress: null, title, msg: `working · ${busy.map(t => t.name).join(", ")}` };
    const here = this.current === null ? null : this.turns.get(this.current.id) ?? null;
    if (here === null || here.outcome === "idle") return { state: "idle", title, msg: null };
    if (here.outcome === "error") return { state: "error", title, msg: `${here.name}: last turn failed` };
    return { state: "done", title, msg: here.gist.length > 0 ? here.gist : `${here.name}: reply ready` };
  }

  private refresh(): void {
    if (!this.enabled) return;
    const busy = [...this.turns.values()].some(t => t.busy);
    if (reportsProgress(this.env) && busy !== this.sentProgress && this.send(progress(busy))) this.sentProgress = busy;
    if (!this.terminal.answersStatus() && !inRex(this.env)) return;
    const report = programStatus(this.status());
    if (report !== this.sentStatus && this.send(report)) this.sentStatus = report;
  }

  private notify(body: string): void {
    if (!this.enabled) return;
    const channel = notifyChannel(this.channel, this.env);
    for (const sequence of notification(channel, TITLE, body, this.pick())) this.send(sequence);
  }

  private send(sequence: string): boolean {
    return this.terminal.signal(passthrough(sequence, this.env));
  }
}

export const gistOf = (text: string): string => plainLine((text.trim().split(/\n\s*\n/)[0] ?? "").replace(/[*`]+/g, "").replace(/^[#>\s]+/, ""), GIST);
