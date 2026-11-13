export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** A stored image: its id, the project scope it belongs to and its hash. Never the bytes. */
export interface ImageRef { readonly id: string; readonly scope: string; readonly sha256: string }
