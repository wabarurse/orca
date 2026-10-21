/** Verified Codex catalog snapshot. Standard context_window, NOT opt-in max_context_window.
 * Source (fetched and inspected for this table):
 * https://raw.githubusercontent.com/openai/codex/9b39316997fd8bcecdb2007722f52ef858f0dbd8/codex-rs/models-manager/models.json
 * Effort/fast groups establish no context limits. Unlisted models remain unknown.
 */
const standardWindows: Readonly<Record<string, number>> = {
  "gpt-6-astra": 272000,
  "gpt-6.1-sol": 272000,
  "gpt-6-sol": 272000,
  "gpt-6-luna": 272000,
  "gpt-5.6-sol": 272000,
  "gpt-5.6-terra": 272000,
  "gpt-5.6-luna": 272000,
  "gpt-daybreak-blue-latest": 272000,
  "gpt-daybreak-red-latest": 372000,
  "gpt-5.5": 272000,
  "codex-auto-review": 272000,
};
export function modelContextLimit(model: string): number | undefined {
  return standardWindows[model];
}
