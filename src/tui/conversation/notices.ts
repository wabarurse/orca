// Which of the daemon's status lines are informational. The orchestrator
// daemon reports through one channel (client.ts `notice`): its acknowledgements
// (a cancel, /compact), compaction progress and completion, and also failures,
// warnings and the live reader's problems. The first kind is a transient note
// above the composer (App.note: replaced by the next, cleared by the next key);
// the rest are conversation lines the user has to read. Anything not listed
// here stays in the conversation, so a new message is never silently transient.

/** The informational lines, as core/agent-loop/orc/daemon.ts, client.ts and core/data/memory/*.ts word them. */
const TRANSIENT: readonly RegExp[] = [
  /^orchestrator: turn cancelled; the orchestrator stays paused until you send a message$/,
  /^orchestrator: nothing was running; queued input stays paused until you send a message$/,
  /^orchestrator: compaction requested; it runs at the next safe boundary$/,
  /^compacting…$/,
  /^compacting older conversation in the background…$/,
  /^compaction complete: /,
  /^background summary did not reduce context; original history kept\.$/,
];

/** Whether a daemon status line is informational: shown as the transient note, not a conversation line. */
export const transientNotice = (text: string): boolean => TRANSIENT.some(re => re.test(text.trim()));
