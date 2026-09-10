import { parse, type ParseError } from "jsonc-parser";

/**
 * Lenient JSON parse: tolerates comments, trailing commas, and BOM — all of
 * which appear in real-world resource packs. Returns undefined on fatal errors.
 */
export function parseLenientJson<T = unknown>(text: string): T | undefined {
  const errors: ParseError[] = [];
  const result = parse(text.replace(/^﻿/, ""), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as T | undefined;
  // jsonc-parser recovers from most errors; only bail if nothing was parsed.
  if (result === undefined && errors.length > 0) return undefined;
  return result;
}

/**
 * Strict variant: returns undefined if the document needed *any* recovery.
 *
 * {@link parseLenientJson} deliberately salvages what it can, which is right
 * when a stage only wants to read a file. It is wrong when the parsed value is
 * about to be re-serialised over the original, because the salvage silently
 * becomes the new content — a truncated `{"a.hit":{"sounds":[` is "recovered"
 * to `{"a.hit":{"sounds":[]}}`, turning a broken file into a valid file that
 * has lost its data. Comments and trailing commas are still accepted: those are
 * normal in hand-written pack JSON and are not damage.
 */
export function parseStrictJson<T = unknown>(text: string): T | undefined {
  const errors: ParseError[] = [];
  const result = parse(text.replace(/^﻿/, ""), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as T | undefined;
  if (errors.length > 0) return undefined;
  return result;
}
