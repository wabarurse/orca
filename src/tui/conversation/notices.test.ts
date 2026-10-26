import { expect, test } from "bun:test";
import { transientNotice } from "./notices";
import { CANCEL_ACK, COMPACT_ACK } from "../../core/agent-loop/orc/daemon";
import { COMPACTION_STATUS } from "../../core/data/memory/compaction";
import { ROLLING_STATUS } from "../../core/data/memory/rolling-memory";

test("the daemon's acknowledgements and compaction progress are transient; its failures, warnings and anything unknown stay in the conversation", () => {
  // The strings core emits (so a reword there fails here, never silently falling back to a conversation line), with the wording spelled out.
  const transient: [string, string][] = [
    [`orchestrator: ${CANCEL_ACK.turn}`, "orchestrator: turn cancelled; the orchestrator stays paused until you send a message"],
    [`orchestrator: ${CANCEL_ACK.idle}`, "orchestrator: nothing was running; queued input stays paused until you send a message"],
    [`orchestrator: ${COMPACT_ACK}`, "orchestrator: compaction requested; it runs at the next safe boundary"],
    [COMPACTION_STATUS.started, "compacting…"],
    [COMPACTION_STATUS.done, "compaction complete (best-effort; original transcript preserved)"],
    [ROLLING_STATUS.started, "compacting older conversation in the background…"],
    [ROLLING_STATUS.done(12000, 3000), "compaction complete: ~12000 → ~3000 history tokens; recent messages unchanged."],
    [ROLLING_STATUS.unchanged, "background summary did not reduce context; original history kept."],
    [`${ROLLING_STATUS.started}\n`, "compacting older conversation in the background…\n"], // a status line's newline
  ];
  for (const [text, wording] of transient) expect([text, transientNotice(text)]).toEqual([wording, true]);
  for (const text of [
    "orchestrator: turn failed: boom; send another message to resume with retained history",
    "compaction failed: summary exceeds output budget",
    "background compaction failed; original history kept: rolling summary timed out",
    "cancel not acknowledged: orchestrator daemon is not running",
    "orchestrator: live output truncated (over 1 MiB this turn); the full text shows when the turn ends",
    "orchestrator: model x applies from the orchestrator's next request", // not a notice: /model notes its own acknowledgement
    "memory index: could not read projects/x/memory.sqlite",
    `orchestrator: ${CANCEL_ACK.turn}. also this`, // only the exact line
    CANCEL_ACK.turn, // without the client's prefix
    "compaction complete: ~x → ~y history tokens; recent messages unchanged.",
    "",
  ]) expect([text, transientNotice(text)]).toEqual([text, false]);
});
