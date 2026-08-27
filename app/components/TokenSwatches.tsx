type Swatch = {
  label: string;
  className: string;
};

const SWATCHES: Swatch[] = [
  { label: "bg-canvas", className: "bg-bg-canvas" },
  { label: "bg-surface", className: "bg-bg-surface" },
  { label: "border-default", className: "bg-transparent border-2 border-border-default" },
  { label: "accent", className: "bg-accent" },
  { label: "status-success", className: "bg-status-success" },
  { label: "status-error", className: "bg-status-error" },
];

export function TokenSwatches() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-4">
      {SWATCHES.map((swatch) => (
        <div key={swatch.label} className="flex flex-col items-center gap-2">
          <div className={`h-12 w-12 rounded-md ${swatch.className}`} />
          <span className="text-xs text-text-secondary">{swatch.label}</span>
        </div>
      ))}
    </div>
  );
}
