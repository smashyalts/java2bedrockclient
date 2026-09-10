import { useCallback, useRef, useState } from "react";

// Includes double extensions (.tar.gz), so match by suffix, not the last dot.
const VALID_EXTENSIONS = [".zip", ".mcpack", ".tar.gz", ".tgz"];
const MAX_FILE_SIZE = 512 * 1024 * 1024;
/**
 * Cap on the combined upload. Merging decompresses every pack into one tree in
 * the worker at once, so several large packs that each pass the per-file check
 * can still exhaust the tab's memory mid-conversion — which surfaces as a blank
 * crash rather than an error. Bound the total instead.
 */
const MAX_TOTAL_SIZE = 1024 * 1024 * 1024;

/**
 * Staging area for the Java pack(s) to convert.
 *
 * More than one may be dropped: a Bedrock client can only be sent a single
 * pack, so a server running a stack of them (base + furniture + HUD) needs them
 * merged into one. Order is priority — the pack at the top wins any file two
 * packs both define, matching how Minecraft applies a pack list — so the list
 * is reorderable rather than a plain set.
 */
export function DropZone({
  onFiles,
  selected,
}: {
  onFiles: (files: File[]) => void;
  /** Staged packs in priority order; selection doesn't start the conversion. */
  selected: File[];
}) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const add = useCallback(
    (files: File[]) => {
      const accepted: File[] = [];
      const rejected: string[] = [];
      const isDuplicate = (f: File, list: File[]): boolean =>
        list.some((s) => s.name === f.name && s.size === f.size);
      let total = selected.reduce((n, f) => n + f.size, 0);
      for (const file of files) {
        const lower = file.name.toLowerCase();
        if (!VALID_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
          rejected.push(`"${file.name}" is not a .zip, .mcpack or .tar.gz`);
          continue;
        }
        if (file.size > MAX_FILE_SIZE) {
          rejected.push(`"${file.name}" is over ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB`);
          continue;
        }
        // Check the incoming batch too, not just what is already staged: two
        // copies of one pack dropped together would otherwise both be added and
        // then collide on their React key, making the reorder buttons act on
        // the wrong row.
        if (isDuplicate(file, selected) || isDuplicate(file, accepted)) {
          rejected.push(`"${file.name}" is already added`);
          continue;
        }
        if (total + file.size > MAX_TOTAL_SIZE) {
          rejected.push(
            `"${file.name}" would take the total over ${Math.round(MAX_TOTAL_SIZE / 1024 / 1024)} MB`,
          );
          continue;
        }
        total += file.size;
        accepted.push(file);
      }
      // Report every rejection, even when something else in the same drop was
      // accepted — otherwise files vanish silently.
      setError(rejected.length > 0 ? rejected.join(" · ") : null);
      if (accepted.length > 0) onFiles([...selected, ...accepted]);
    },
    [onFiles, selected],
  );

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= selected.length) return;
    const next = [...selected];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onFiles(next);
  };

  const total = selected.reduce((n, f) => n + f.size, 0);

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          dragCounter.current++;
          setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          dragCounter.current--;
          if (dragCounter.current <= 0) {
            dragCounter.current = 0;
            setDragging(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragCounter.current = 0;
          setDragging(false);
          add([...e.dataTransfer.files]);
        }}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragging || selected.length > 0 ? "var(--accent)" : "var(--border)"}`,
          background: dragging ? "var(--accent-dim)" : "var(--panel)",
          borderRadius: 16,
          padding: selected.length > 0 ? "28px 20px" : "80px 20px",
          textAlign: "center",
          cursor: "pointer",
          transition: "all 0.15s ease",
        }}
      >
        <div style={{ fontSize: 40, marginBottom: 12 }}>{selected.length > 0 ? "✅" : "📦"}</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>
          {selected.length === 0
            ? "Drop your Java resource pack here"
            : selected.length === 1
              ? selected[0]!.name
              : `${selected.length} packs — will be merged into one`}
        </div>
        <div style={{ color: "var(--muted)", marginTop: 6 }}>
          {selected.length === 0
            ? ".zip, .mcpack, or .tar.gz — drop several to merge them into one Bedrock pack"
            : `${(total / 1024 / 1024).toFixed(1)} MB total — click to add another pack`}
        </div>
        {error !== null && <div style={{ color: "var(--err)", marginTop: 12, fontSize: 13 }}>{error}</div>}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".zip,.mcpack,.tar.gz,.tgz,application/gzip"
          style={{ display: "none" }}
          onChange={(e) => {
            add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>

      {selected.length > 0 && (
        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 12,
            marginTop: 12,
            display: "grid",
            gap: 6,
          }}
        >
          <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 2 }}>
            {selected.length === 1
              ? "Staged pack — remove it with ✕ to pick a different one."
              : "Merge order — #1 wins any file two packs both contain. Sounds, language files, atlases and fonts are combined instead, so nothing is lost from those."}
          </div>
          {selected.map((file, i) => (
            <div
              key={`${file.name}:${file.size}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "6px 8px",
              }}
            >
              <span style={{ fontWeight: 700, minWidth: 18, color: "var(--accent)" }}>{i + 1}</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {file.name}
              </span>
              <span style={{ color: "var(--muted)", fontSize: 12 }}>
                {(file.size / 1024 / 1024).toFixed(1)} MB
              </span>
              <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} style={miniButton}>
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, i + 1)}
                disabled={i === selected.length - 1}
                style={miniButton}
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => onFiles(selected.filter((_, j) => j !== i))}
                style={{ ...miniButton, color: "var(--err)" }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const miniButton: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--fg)",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1,
  padding: "4px 7px",
};
