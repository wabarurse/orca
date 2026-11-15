// The Images page's rows, per open page: the delivered images from the
// orchestrator transcript (newest first), the captured videos when asked, and
// the archive flags, with a count of the unarchived ones. Kept out of app.ts
// because it is a media concern, not the app loop. The page is the WeakMap key,
// so a closed page's list is collected with it.
import { paths } from "../../config";
import { workViews } from "../../core/data/projects";
import { open } from "../../core/data/transcripts";
import type { Entry } from "../../protocol";
import { deliveredImages } from "./images";
import { capturedVideos, type DeliveredMedia } from "./media";

interface ImageList { head?: string; rows: DeliveredMedia[]; archived: Record<string, boolean>; count: number }

const count = (rows: DeliveredMedia[], archived: Record<string, boolean>): number =>
  rows.filter(media => !(archived[media.id] ?? media.archived)).length;

export class ImageLists<P extends { project: string } & object> {
  private readonly lists = new WeakMap<P, ImageList>();

  get(page: P): ImageList | undefined { return this.lists.get(page); }
  has(page: P): boolean { return this.lists.has(page); }

  /** Rebuild from the transcript (and, when asked, the captured videos). */
  async read(page: P, includeVideos = false): Promise<void> {
    const path = paths.transcript(page.project, "orchestrator");
    const transcript = await Bun.file(path).exists() ? open(path) : undefined;
    this.update(page, transcript ? transcript.history?.() ?? transcript.branch() : []);
    const videos = includeVideos ? await capturedVideos(page.project) : undefined;
    const list = this.lists.get(page)!;
    if (videos) list.rows = [...list.rows.filter(row => row.kind === "image"), ...videos].sort((a, b) => b.at.localeCompare(a.at));
    list.archived = workViews.workArchive(page.project, "images");
    list.count = count(list.rows, list.archived);
  }

  /** Refresh the image rows from new transcript entries, keeping any videos; a no-op when the head is unchanged. */
  update(page: P, entries: readonly Entry[]): void {
    const head = entries.at(-1)?.uuid;
    const previous = this.lists.get(page);
    if (previous && previous.head === head) return;
    const rows: DeliveredMedia[] = [...deliveredImages(entries).map(image => ({ ...image, kind: "image" as const, id: image.ref.id })),
      ...(previous?.rows.filter(row => row.kind === "video") ?? [])];
    rows.sort((a, b) => b.at.localeCompare(a.at));
    const archived = workViews.workArchive(page.project, "images");
    this.lists.set(page, { head, rows, archived, count: count(rows, archived) });
  }
}
