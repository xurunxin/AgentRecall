// Bottom-left control buttons for the hand-rolled graph view.
//
// We replaced xyflow's <Controls /> in task 31, so this is the equivalent
// from scratch: zoom in / zoom out / fit-to-view / reset. Kept small and
// inline-styled so it inherits the same dark/light theme as the rest of
// the canvas (uses --bg-elev / --border / --text).
//
// Sits on top of the canvas with `position: absolute; bottom; left; zIndex`
// so it doesn't interfere with node drag or canvas pan. Each button is a
// small square; the row stacks vertically so it doesn't take much space.

interface Props {
  /** Current zoom level, 0.2–3.0. Used for the percent indicator. */
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onReset: () => void;
}

const buttonBase = {
  width: 32,
  height: 32,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
  fontFamily: "inherit",
} as const;

export default function Controls({ zoom, onZoomIn, onZoomOut, onFit, onReset }: Props) {
  return (
    <div
      data-testid="graph-controls"
      style={{
        position: "absolute",
        left: 16,
        bottom: 16,
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        // Outer container has no own border — each button gets one. The
        // small gap above visually merges the stack into a single panel.
        background: "var(--border)",
        borderRadius: 4,
        overflow: "hidden",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      }}
    >
      <button
        type="button"
        onClick={onZoomIn}
        title="放大"
        aria-label="放大"
        style={buttonBase}
      >
        +
      </button>
      <button
        type="button"
        onClick={onZoomOut}
        title="缩小"
        aria-label="缩小"
        style={buttonBase}
      >
        −
      </button>
      <button
        type="button"
        onClick={onFit}
        title="适应窗口"
        aria-label="适应窗口"
        style={{ ...buttonBase, fontSize: 13 }}
      >
        ⤢
      </button>
      <button
        type="button"
        onClick={onReset}
        title={`重置 (${(zoom * 100).toFixed(0)}%)`}
        aria-label="重置视图"
        style={{ ...buttonBase, fontSize: 12 }}
      >
        ⊙
      </button>
    </div>
  );
}
