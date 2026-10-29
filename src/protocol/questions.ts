// The orchestrator's questions for the user as the questions panel shows them
// (core/data/inbox/questions.ts keeps the queue) and the limits on their text.

export type Status = "open" | "answered" | "skipped";

export interface Question {
  id: string;
  text: string;
  options?: string[];
  default?: string;
  status: Status;
  answer?: string;
  /** Why the orchestrator withdrew it (answered in chat, outdated): set only by its close, never by the user's Skip or delete. */
  reason?: string;
  ts: string;
}

export type NewQuestion = Pick<Question, "text" | "options" | "default">;

/** `reason` caps an orchestrator close's reason, `close` the ids one close call takes. */
export const limits = { text: 500, option: 100, options: 8, questions: 10, answer: 2000, reason: 200, close: 20 };
