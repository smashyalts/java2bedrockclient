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
