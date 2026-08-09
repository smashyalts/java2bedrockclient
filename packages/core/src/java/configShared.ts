/**
 * Helpers shared by every item-plugin config parser (Oraxen/Nexo/ItemsAdder in
 * {@link ./oraxen.ts}, CraftEngine in {@link ./craftEngine.ts}). Kept in their
 * own module so the parsers stay one-way dependencies of it rather than of each
 * other.
 */

/**
 * Everything the converter learns from a server's item-plugin configs. Every
 * map is keyed the way the pipeline looks items up: the config key, the
 * `item_model` path, and the model file's last path segment — all namespace
 * stripped and lowercased.
 */
export interface ConfigHints {
  /** item key (e.g. "ruby_sword") → java item id (e.g. "minecraft:diamond_sword"). */
  baseItems: Record<string, string>;
  /** item key → display name from the config (colour codes stripped). */
  displayNames: Record<string, string>;
  /** item key → equippable armor link from the config. */
  equippables: Record<string, { asset: string; slot: string }>;
  /**
   * item key → fixed dye colour (0xRRGGBB) from the config (leather armor,
   * potions). Java applies it server-side; Bedrock icons need it baked in.
   */
  colors: Record<string, number>;
  /** "minecraft:material|cmd" → item key (for packs dispatching on custom_model_data). */
  cmdKeys: Record<string, string>;
  /**
   * Item keys worn as back cosmetics (HMCCosmetics BACKPACK entries — armor
   * stand head items that Bedrock renders lower than Java).
   */
  backpacks: string[];
  /**
   * Item keys placed in the world as furniture (Oraxen/Nexo Mechanics.furniture,
   * ItemsAdder behaviours.furniture, CraftEngine furniture_item behaviour and
   * `furniture:` definitions) — display-entity items that need the
   * GeyserDisplayEntity extension to show on Bedrock.
   */
  furniture: string[];
  /**
   * Per-furniture-key placement hints from the plugin's furniture mechanic:
   * `none` = the item_display uses NONE (identity) transform, so nothing
   * repositions it at runtime and it must be seated by y-offset; `scale` = the
   * furniture's own scale (Nexo `scale: x,y,z`, CraftEngine element `scale`),
   * used to decide `vanilla-scale`. These come from the plugin config, which
   * overrides the model's own `display.fixed` (Nexo authors set the transform
   * here, not in the model).
   */
  furnitureTransforms: Record<string, { none: boolean; scale: number }>;
  /** yml files parsed / items discovered, for reporting. */
  files: number;
  items: number;
}

/** Drop the `namespace:` prefix and lowercase — the form every hint map is keyed by. */
export function stripNamespace(id: string): string {
  const idx = id.indexOf(":");
  return (idx === -1 ? id : id.slice(idx + 1)).toLowerCase();
}

/**
 * Largest absolute component of a `scale` value ("x,y,z", [x,y,z], or a bare
 * number); 1 when absent. Drives whether furniture should use the entity's
 * vanilla scale on Bedrock.
 */
export function parseScaleMagnitude(scale: unknown): number {
  let parts: number[] = [];
  if (typeof scale === "number") parts = [scale];
  else if (typeof scale === "string") parts = scale.split(",").map((s) => Number.parseFloat(s.trim()));
  else if (Array.isArray(scale)) {
    parts = scale.map((s) => (typeof s === "number" ? s : Number.parseFloat(String(s))));
  }
  const finite = parts.filter((n) => Number.isFinite(n)).map((n) => Math.abs(n));
  return finite.length > 0 ? Math.max(...finite) : 1;
}

/**
 * Strip legacy colour codes (`&c`, `§c`) and MiniMessage tags (`<red>`,
 * `<#FF8C00>`, `<!i>`) from a display name. Returns undefined when nothing
 * printable is left.
 */
export function stripFormatting(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const stripped = raw
    .replace(/[§&][0-9a-fk-orx]/gi, "")
    .replace(/<[^<>]+>/g, "")
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}

/** Parse a colour written as "#RRGGBB", "R,G,B", [R,G,B], or a packed integer. */
export function parseColor(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw & 0xffffff;
  if (Array.isArray(raw) && raw.length === 3) {
    const [r, g, b] = raw.map((v) => (typeof v === "number" ? v : Number.parseInt(String(v), 10)));
    if ([r, g, b].every((n) => Number.isInteger(n) && n! >= 0 && n! <= 255)) {
      return (r! << 16) | (g! << 8) | b!;
    }
    return undefined;
  }
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  const hex = text.match(/^#?([0-9a-fA-F]{6})$/);
  if (hex) return parseInt(hex[1]!, 16);
  const rgb = text.match(/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/);
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if (r <= 255 && g <= 255 && b <= 255) return (r << 16) | (g << 8) | b;
  }
  // Packed decimal integer (custom plugins like oxywire: color: "10568504").
  // Only 7+ digits — a 6-digit value is ambiguous with bare hex, handled above.
  if (/^\d{7,}$/.test(text)) {
    const n = Number.parseInt(text, 10);
    if (Number.isFinite(n)) return n & 0xffffff;
  }
  return undefined;
}

/** Narrow an unknown to a plain object (not null, not an array). */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
