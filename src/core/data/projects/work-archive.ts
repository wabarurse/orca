import { paths, projectStateScope, readProjectState, updateState } from "../../../config";

export type WorkArchiveKind = "images" | "questions";
const key = (kind: WorkArchiveKind) => `work-archive-${kind}`;
/** Presentation only: restoring a question never reopens it or sends an answer. */
export function workArchive(project: string, kind: WorkArchiveKind): Record<string, boolean> {
  const saved = readProjectState<Record<string, boolean>>(project, key(kind));
  return saved && typeof saved === "object" && !Array.isArray(saved)
    ? Object.fromEntries(Object.entries(saved).filter(([, archived]) => typeof archived === "boolean")) : {};
}
export function setWorkArchived(project: string, kind: WorkArchiveKind, ids: string[], archived: boolean): void {
  updateState<Record<string, boolean>>(paths.memory, projectStateScope(project), key(kind), old => ({
    ...old, ...Object.fromEntries(ids.map(id => [id, archived])),
  }));
}
