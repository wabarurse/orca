// How much of a model's window a request uses, and how much room its reply gets. Estimates are deliberately
// conservative (UTF-8 bytes / 3); a provider's own count, once known, corrects later estimates.
import type { MessageParam, Tool as ApiTool } from "@anthropic-ai/sdk/resources/messages";
import { contextWindow } from "../../api/model";

/** The last provider-reported input count, and what we estimated for the same request. */
export type Measured = { input: number; estimated: number; model: string };

export type Window = {
  model: string;
  system: string;
  tools: ApiTool[];
  /** An explicit window size; null uses the model's known window. */
  contextLimit: number | null;
  measured: Measured | null;
};

export const estimate = (value: unknown): number => {
  let images = 0;
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "object" && item !== null && (item as { type?: unknown }).type === "image") { images++; return { type: "image" }; }
    return item;
  }) ?? "";
  return Math.ceil(Buffer.byteLength(text) / 3) + 32 + images * 6000;
};

export const limitOf = (window: Window): number =>
  contextWindow(window.contextLimit === null ? {} : { contextLimit: window.contextLimit }, window.model).limit;

export function budget(window: Window, messages: MessageParam[]): number {
  const estimated = estimate(messages) + estimate(window.system) + estimate(window.tools) + 1024;
  const measured = window.measured;
  return measured !== null && measured.model === window.model ? Math.max(estimated, measured.input + estimated - measured.estimated) : estimated;
}

/** A request's reply cap: at most 64k, and at most a fifth of the window. */
export function outputCap(window: Window): number {
  const limit = limitOf(window);
  return Math.max(1, Math.min(64000, Math.floor(limit * 0.2), Math.floor(limit - 1)));
}

const MIN_REPLY = 8192;
const margin = (limit: number): number => Math.min(13_000, limit * 0.03);

export function inputRoom(limit: number, reserve: number): number {
  return limit - Math.min(reserve, MIN_REPLY) - margin(limit);
}

export function replyCap(window: Window, messages: MessageParam[]): number {
  const limit = limitOf(window);
  return Math.max(1, Math.min(outputCap(window), Math.floor(limit - budget(window, messages) - margin(limit))));
}

export class ContextBlocked extends Error {}

export function fits(window: Window, messages: MessageParam[]): boolean {
  return budget(window, messages) <= inputRoom(limitOf(window), outputCap(window));
}

export function requireFits(window: Window, messages: MessageParam[], label: string): void {
  if (!fits(window, messages)) throw new ContextBlocked(`context blocked: ${label} does not fit the model's window with room for a reply; choose a larger model or compact. The transcript is unchanged.`);
}
