/**
 * Minimal in-memory virtual filesystem. Paths are forward-slash, no leading slash.
 * Used for both the parsed Java pack and the Bedrock pack being built, so the
 * core stays independent of Node/browser filesystem APIs.
 */
export class VirtualFs {
  private files = new Map<string, Uint8Array>();
  private sortedPaths: string[] | null = null;

  private invalidate(): void {
    this.sortedPaths = null;
  }

  static normalize(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\/+/, "");
  }

  has(path: string): boolean {
    return this.files.has(VirtualFs.normalize(path));
  }

  read(path: string): Uint8Array | undefined {
    return this.files.get(VirtualFs.normalize(path));
  }

  readText(path: string): string | undefined {
    const data = this.read(path);
    if (data === undefined) return undefined;
    return new TextDecoder("utf-8").decode(data);
  }

  write(path: string, data: Uint8Array): void {
    this.files.set(VirtualFs.normalize(path), data);
    this.invalidate();
  }

  writeText(path: string, text: string): void {
    this.write(path, new TextEncoder().encode(text));
  }

  writeJson(path: string, value: unknown, pretty = true): void {
    this.writeText(path, JSON.stringify(value, null, pretty ? 2 : undefined));
  }

  delete(path: string): boolean {
    const deleted = this.files.delete(VirtualFs.normalize(path));
    if (deleted) this.invalidate();
    return deleted;
  }

  /** All paths, optionally filtered by prefix and/or suffix. */
  list(options?: { prefix?: string; suffix?: string }): string[] {
    const prefix = options?.prefix ? VirtualFs.normalize(options.prefix) : undefined;
    const suffix = options?.suffix;
    if (this.sortedPaths === null) {
      this.sortedPaths = [...this.files.keys()].sort();
    }
    if (prefix === undefined && suffix === undefined) return [...this.sortedPaths];
    const out: string[] = [];
    for (const path of this.sortedPaths) {
      if (prefix !== undefined && !path.startsWith(prefix)) continue;
      if (suffix !== undefined && !path.endsWith(suffix)) continue;
      out.push(path);
    }
    return out;
  }

  get size(): number {
    return this.files.size;
  }

  entries(): IterableIterator<[string, Uint8Array]> {
    return this.files.entries();
  }
}
