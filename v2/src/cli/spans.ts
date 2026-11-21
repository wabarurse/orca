import { readConversation } from "../core/conversations";
import { formatReport, spanReport } from "../core/span-report";
import { readSpans } from "../core/spans";

export async function runSpans(conversation: string, json: boolean, out: (text: string) => void): Promise<number> {
  if (await readConversation(conversation) === null) { out(`no conversation ${conversation}\n`); return 1; }
  const spans = await readSpans(conversation);
  if (!spans.ok) { out(`could not read spans: ${spans.error}\n`); return 1; }
  const report = spanReport(conversation, spans.data);
  out(json ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
  return 0;
}
