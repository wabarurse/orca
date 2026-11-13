// Attachment references as the TUI shows and sends them (core/data/images/images.ts
// validates and stores the bytes; disk and transcripts never carry data URIs).

import type { ImageRef } from "../types";
export interface ImageInput { readonly inputId: string; text: string; submission?: string; attachments: ImageRef[] }
