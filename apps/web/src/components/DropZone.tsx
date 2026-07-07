import { useCallback, useRef, useState } from "react";

export function DropZone({ onFile }: { onFile: (file: File) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
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
      <input
        ref={inputRef}
        type="file"
        accept=".zip,.mcpack"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
