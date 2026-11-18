// A conversation the user deleted is archived, not removed: it leaves every list, nothing of it runs, and its
// files stay until `orca clean` purges it. The record names what the archive itself put away, so a restore brings
// back exactly that and leaves what the user had archived before as it was.
import { readProjectState, writeProjectState } from "../../../config";

export interface ProjectArchive {
  at: string;
  /** Tasks removed from the list by this archive. */
  tasks: string[];
  /** Questions and agents it hid, and the worktree sessions it marked archived. */
  questions: string[]; agents: string[]; sessions: string[];
}

/** The archive record of a conversation, undefined while it is live (or unreadable: an unreadable one is listed). */
export function projectArchive(project: string): ProjectArchive | undefined {
  try { return readProjectState<ProjectArchive>(project, "archived"); } catch { return undefined; }
}
export const setProjectArchive = (project: string, archive: ProjectArchive | undefined): void => writeProjectState(project, "archived", archive);
