// Which of the daemon's status lines are informational. The orchestrator
// daemon reports through one channel (client.ts `notice`): its acknowledgements
// (a cancel, /compact), compaction progress and completion, and also failures,
// warnings and the live reader's problems. The first kind is a transient note
// above the composer (App.note: replaced by the next, cleared by the next key);
// the rest are conversation lines the user has to read. The informational
// lines are the strings core emits, imported, so a reword cannot leave one
// behind; anything not listed stays in the conversation.
import type { ModelRequestEntry } from "../../protocol";
import { CANCEL_ACK, COMPACT_ACK } from "../../core/agent-loop/orc";
import { COMPACTION_STATUS, ROLLING_STATUS } from "../../core/data/memory";

/** The acknowledgements as the client words them (client.ts `cancel`, `compact`), and the fixed compaction lines. */
const EXACT = new Set<string>([
  `orchestrator: ${CANCEL_ACK.turn}`, `orchestrator: ${CANCEL_ACK.idle}`, `orchestrator: ${COMPACT_ACK}`,
  COMPACTION_STATUS.started, COMPACTION_STATUS.done, ROLLING_STATUS.started, ROLLING_STATUS.unchanged,
]);
/** Background compaction's completion carries its token counts (notices.test.ts checks it against ROLLING_STATUS.done). */
const DONE = /^compaction complete: ~\d+ → ~\d+ history tokens; recent messages unchanged\.$/;

/** Routine request metadata remains in the transcript, not conversational history.
 * Errors/aborts are deliberately excluded: unknown outcomes must remain visible. */
export function routineModelRequest(stage: ModelRequestEntry["stage"]): boolean {
  return stage === "preparing" || stage === "provider-wait" || stage === "completed";
}

// Match the complete diagnostic format, not retry/failure messages or arbitrary
// lines containing a stage name. The live bridge transports this as plain status.
const REQUEST_PROGRESS = /^\[model request\] \S+\/\S+ (preparing|provider-wait|completed); started \S+; updated \S+$/;

/** Whether a daemon status line is informational: shown as the transient note, not a conversation line. */
export function transientNotice(text: string): boolean {
  const line = text.trim();
  return EXACT.has(line) || DONE.test(line) || REQUEST_PROGRESS.test(line);
}
