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
  ts: string;
}

export type NewQuestion = Pick<Question, "text" | "options" | "default">;

export const limits = { text: 500, option: 100, options: 8, questions: 10, answer: 2000 };
