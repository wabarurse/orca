import { paths, projectStateScope, readProjectState, updateState } from "../../../config";
import * as workspaces from "./workspace-sessions";

export type WorkArchiveKind = "images" | "questions";
const key = (kind: WorkArchiveKind) => `work-archive-${kind}`;
/** Presentation only: restoring a question never reopens it or sends an answer. */
export function workArchive(project: string, kind: WorkArchiveKind): Record<string, boolean> {
  const saved = readProjectState<Record<string, boolean>>(project, key(kind));
  const explicit = saved && typeof saved === "object" && !Array.isArray(saved)
    ? Object.fromEntries(Object.entries(saved).filter(([, archived]) => typeof archived === "boolean")) : {};
  return { ...explicit, ...workspaces.archivedResources(project, kind === "images" ? "image" : "question") };
}
export function setWorkArchived(project: string, kind: WorkArchiveKind, ids: string[], archived: boolean): void {
  if (!archived) for (const id of ids) workspaces.restore(project, kind === "images" ? "image" : "question", id);
  updateState<Record<string, boolean>>(paths.memory, projectStateScope(project), key(kind), old => ({
    ...old, ...Object.fromEntries(ids.map(id => [id, archived])),
  }));
}
