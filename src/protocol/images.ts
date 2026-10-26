// Attachment references as the TUI shows and sends them (core/data/images/images.ts
// validates and stores the bytes; disk and transcripts never carry data URIs).

export interface ImageRef { readonly id: string; readonly scope: string; readonly sha256: string }
export interface ImageInput { readonly inputId: string; text: string; submission?: string; attachments: ImageRef[] }
