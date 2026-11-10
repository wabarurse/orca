import { inputArea, questionRows, type Input, type QuestionView } from "./render";

/** The answer editor lives beside the questions list, never below chat input. */
export function questionPageRows(question: QuestionView, input: Input, cols: number, height: number) {
  const answer = question.mode === "answer" ? inputArea(input, cols, Math.max(1, height)) : undefined;
  const choices = questionRows(question, cols, Math.max(0, height - (answer?.lines.length ?? 0)), false);
  return { rows: [...choices, ...(answer?.lines ?? [])].slice(0, height),
    cursor: answer ? { row: choices.length + answer.row, col: answer.col } : undefined };
}
