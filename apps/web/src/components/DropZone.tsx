import { useCallback, useRef, useState } from "react";

const VALID_EXTENSIONS = [".zip", ".mcpack"];
const MAX_FILE_SIZE = 512 * 1024 * 1024;

export function DropZone({ onFile }: { onFile: (file: File) => void }) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const validateAndSubmit = useCallback(
    (file: File) => {
      const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
      if (!VALID_EXTENSIONS.includes(ext)) {
        setError(`"${file.name}" is not a .zip or .mcpack file`);
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        setError(`"${file.name}" is too large (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB)`);
        return;
      }
      setError(null);
      onFile(file);
    },
    [onFile],
  );

  return (
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
        const file = e.dataTransfer.files[0];
        if (file) validateAndSubmit(file);
      }}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${dragging ? "var(--accent)" : "var(--border)"}`,
        background: dragging ? "var(--accent-dim)" : "var(--panel)",
        borderRadius: 16,
        padding: "80px 20px",
        textAlign: "center",
        cursor: "pointer",
        transition: "all 0.15s ease",
      }}
    >
      <div style={{ fontSize: 40, marginBottom: 12 }}>📦</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>
        Drop your Java resource pack .zip here
      </div>
      <div style={{ color: "var(--muted)", marginTop: 6 }}>or click to choose a file</div>
      {error && (
        <div style={{ color: "var(--err)", marginTop: 12, fontSize: 13 }}>{error}</div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".zip,.mcpack"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) validateAndSubmit(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
