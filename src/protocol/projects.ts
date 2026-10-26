// The project-list row record (core/data/projects/registry.ts builds the list).

/** A project in the list: its id (folder, pins, delete) and the label it shows (its display name). */
export interface ProjectEntry { name: string; label: string; pinned: boolean }
