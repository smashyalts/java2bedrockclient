export type ConversionStatus = "converted" | "approximated" | "skipped" | "error";

export interface ReportEntry {
  /** Pipeline stage that produced this entry, e.g. "textures", "items-2d". */
  stage: string;
  /** Source path or logical identifier in the Java pack. */
  source: string;
  status: ConversionStatus;
  /** Output path(s) in the Bedrock pack, when applicable. */
  outputs?: string[];
  /** Human-readable explanation, mandatory for approximated/skipped/error. */
  detail?: string;
}

export class ConversionReport {
  readonly entries: ReportEntry[] = [];

  add(entry: ReportEntry): void {
    this.entries.push(entry);
  }

  converted(stage: string, source: string, outputs?: string[]): void {
    this.add({ stage, source, status: "converted", outputs });
  }

  approximated(stage: string, source: string, detail: string, outputs?: string[]): void {
    this.add({ stage, source, status: "approximated", detail, outputs });
  }

  skipped(stage: string, source: string, detail: string): void {
    this.add({ stage, source, status: "skipped", detail });
  }

  error(stage: string, source: string, detail: string): void {
    this.add({ stage, source, status: "error", detail });
  }

  count(status: ConversionStatus): number {
    return this.entries.filter((e) => e.status === status).length;
  }

  toJSON(): { summary: Record<ConversionStatus, number>; entries: ReportEntry[] } {
    return {
      summary: {
        converted: this.count("converted"),
        approximated: this.count("approximated"),
        skipped: this.count("skipped"),
        error: this.count("error"),
      },
      entries: this.entries,
    };
  }
}
