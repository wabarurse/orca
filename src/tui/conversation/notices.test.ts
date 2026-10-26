import { expect, test } from "bun:test";
import { transientNotice } from "./notices";

test("the daemon's acknowledgements and compaction progress are transient; its failures, warnings and anything unknown stay in the conversation", () => {
  for (const text of [
    "orchestrator: turn cancelled; the orchestrator stays paused until you send a message",
    "orchestrator: nothing was running; queued input stays paused until you send a message",
    "orchestrator: compaction requested; it runs at the next safe boundary",
    "compacting…",
    "compacting older conversation in the background…",
    "compaction complete: ~12000 → ~3000 history tokens; recent messages unchanged.",
    "background summary did not reduce context; original history kept.",
    "compacting older conversation in the background…\n", // a status line's newline
  ]) expect([text, transientNotice(text)]).toEqual([text, true]);
  for (const text of [
    "orchestrator: turn failed: boom; send another message to resume with retained history",
    "compaction failed: summary exceeds output budget",
    "background compaction failed; original history kept: rolling summary timed out",
    "cancel not acknowledged: orchestrator daemon is not running",
    "orchestrator: live output truncated (over 1 MiB this turn); the full text shows when the turn ends",
    "orchestrator: model x applies from the orchestrator's next request", // not a notice: /model notes its own acknowledgement
    "memory index: could not read projects/x/memory.sqlite",
    "orchestrator: turn cancelled; the orchestrator stays paused until you send a message. also this", // only the exact line
    "",
  ]) expect([text, transientNotice(text)]).toEqual([text, false]);
});
