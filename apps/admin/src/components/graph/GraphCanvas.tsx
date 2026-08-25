// Hand-rolled graph view (replaces reactflow / @xyflow/react).
//
// Why we abandoned xyflow: 6 prior attempts to make edges visible and nodes
// draggable inside Tauri 2.0's WebView2 (Microsoft Edge runtime) failed. The
// library's pointer-event pipeline (useGesture + synthetic PointerEvents) drops
// pointermove/pointerup on some WebView2 builds, and SVG path stacking under
// the node div renders edges invisible even with high zIndex. Rather than
// patch around library internals, we use plain DOM + standard mousedown /
// mousemove / mouseup + CSS `transform: translate(x,y) scale(s)`. Standard
// React event handling, no exotic pointer-event bookkeeping, 100% compatible
// with any browser/webview.
//
// Layout: dagre still computes initial node positions (LR rankdir, 40/60
// spacing). After mount, users can drag nodes freely; dragged positions are
// kept across polling ticks in a `positionsRef` so re-renders from
// `useGraph`/`usePolling` don't snap the graph back to the dagre layout.
//
// Coordinate system: positions are stored in *graph space* (pre-pan, pre-zoom).
// The inner `<div>` applies `transform: translate(panX, panY) scale(zoom)`, so
// `mousemove` deltas need to be divided by `zoom` to convert from screen
// pixels to graph units.
//
// Components owned by this file:
//   - Background grid (inside the transformed layer, pans/zooms with graph).
//   - Edges (inline SVG, sized to graph extents + padding so lines never clip).
//   - Nodes (absolute-positioned divs wrapping <MemoryNode />).
//   - Controls (zoom in/out, fit, reset) — bottom-left.
//   - MiniMap (read-only overview) — bottom-right.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphNode } from "@agent-recall/contracts";
import MemoryNode from "./MemoryNode.js";
import Controls from "./Controls.js";
import MiniMap from "./MiniMap.js";

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  total: number;
  /** Click on a node. Receives the underlying GraphNode. */
  onNodeClick?: (node: GraphNode) => void;
}

// Hex values for edges. SVG `stroke` does not resolve CSS vars reliably across
// WebView2 builds, so we keep these in sync with `--edge-*` in `theme.css`.
const edgeKindColor: Record<GraphEdge["kind"], string> = {
  supersede: "#2563eb", // blue
  merge: "#7c3aed", // purple
  co_topic: "#f59e0b", // amber
  co_scope: "#9ca3af", // gray
};

const edgeKindDash: Record<GraphEdge["kind"], string | undefined> = {
  supersede: undefined,
  merge: undefined,
  co_topic: "4 4",
  co_scope: "4 4",
};

// Background grid cell size (graph space). 20px keeps the grid visible at the
// default zoom and doesn't get too sparse when the user zooms out.
const GRID_SIZE = 20;

// Padding around the bounding box of all node positions, in graph space.
// The edge SVG is sized to (bounds + padding) so endpoints near the edge of
// the canvas never get clipped.
const EDGE_PADDING = 100;

// dagre box matches the visible node footprint so edge endpoints land on the
// actual circle boundary. 42px circle + 8px gap + ~90px avg label = 140.
const NODE_WIDTH = 42 + 8 + 90; // 140
const NODE_HEIGHT = 42;

// The visible disk (the 42px circle inside MemoryNode). Must match
// `CIRCLE_BASE` in MemoryNode.tsx — kept as a separate const so the edge
// anchor math lives in one place. Edge endpoints target the *center* of
// this circle, not the center of the entire node wrapper, because the
// label on the right biases the wrapper's center off the actual disk.
const CIRCLE_WIDTH = 42;

type Position = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * Run dagre layout over the given nodes. Returns a map of nodeId → position
 * (graph-space center coordinates). Nodes that aren't in the dagre graph
 * (isolates) are placed in a small grid so they still render.
 */
function layoutWithDagre(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Record<string, Position> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: 40,
    ranksep: 60,
    marginx: 40,
    marginy: 40,
  });

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((e) => {
    // Only lay out edges whose endpoints both exist in the node set.
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  });

  dagre.layout(g);

  const out: Record<string, Position> = {};
  const isolates: GraphNode[] = [];
  nodes.forEach((n) => {
    const dn = g.node(n.id);
    if (dn) {
      out[n.id] = { x: dn.x, y: dn.y };
    } else {
      isolates.push(n);
    }
  });

  // Place any isolates on a 3-column grid below the main layout so they
  // remain visible but separate. dagre returns undefined for nodes with no
  // edges, so they fall through here.
  isolates.forEach((n, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    out[n.id] = {
      x: 40 + NODE_WIDTH / 2 + col * (NODE_WIDTH + 40),
      y: 40 + NODE_HEIGHT / 2 + row * (NODE_HEIGHT + 60),
    };
  });

  return out;
}

function computeBounds(positions: Map<string, Position>): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of positions.values()) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) {
    // Empty graph: a default 200×200 box so the SVG still has positive size.
    return { minX: 0, minY: 0, maxX: 200, maxY: 200 };
  }
  return { minX, minY, maxX, maxY };
}

interface DragState {
  nodeId: string;
  /** Screen-space mouse position at drag start. */
  startScreenX: number;
  startScreenY: number;
  /** Graph-space node position at drag start. */
  startNodeX: number;
  startNodeY: number;
  /** True if the pointer moved beyond the click threshold (no click). */
  moved: boolean;
}

const CLICK_THRESHOLD_PX = 5;

export default function GraphCanvas({ nodes, edges, truncated, total, onNodeClick }: Props) {
  // Container ref used by fit-to-view to read the visible viewport size.
  const containerRef = useRef<HTMLDivElement>(null);

  // Persisted drag positions survive polling re-renders. The ref lets us
  // reach the latest positions inside mousemove without re-binding the
  // global listener on every move.
  const positionsRef = useRef<Map<string, Position>>(new Map());
  // Bump this when we mutate positionsRef so consumers re-read them.
  const [positionsTick, setPositionsTick] = useState(0);

  // Pan + zoom state. `transform-origin: 0 0` lets us anchor the inner div
  // at top-left and translate relative to that anchor.
  const [pan, setPan] = useState<Position>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  // Drag state for the currently-dragged node (null when not dragging).
  const [drag, setDrag] = useState<DragState | null>(null);

  // Pan state for canvas drag (null when not panning).
  const [panDrag, setPanDrag] = useState<
    { startScreenX: number; startScreenY: number; startPanX: number; startPanY: number } | null
  >(null);

  // Recompute dagre layout whenever the upstream node/edge set changes
  // (new server response, filter change). Memoized on identity so we don't
  // recompute on every render.
  const baseLayout = useMemo(() => layoutWithDagre(nodes, edges), [nodes, edges]);

  // Reset the user-drag map when the node identity set changes materially
  // (e.g. filter swap). If a node from the new set was previously dragged,
  // keep its position; otherwise adopt the dagre default.
  useEffect(() => {
    const next = new Map<string, Position>();
    for (const n of nodes) {
      const prev = positionsRef.current.get(n.id);
      next.set(n.id, prev ?? baseLayout[n.id] ?? { x: 0, y: 0 });
    }
    positionsRef.current = next;
    setPositionsTick((t) => t + 1);
  }, [baseLayout, nodes]);

  // Pre-fill positions for any node not in the map yet (defensive — covers
  // the case where a single node is added between two renders).
  const getPosition = useCallback(
    (id: string): Position => {
      const have = positionsRef.current.get(id);
      if (have) return have;
      const fallback = baseLayout[id] ?? { x: 0, y: 0 };
      positionsRef.current.set(id, fallback);
      return fallback;
    },
    [baseLayout]
  );

  // Each node's wrapper is positioned so the disk (the 42px circle, fixed
  // size) sits with its top-left at (pos.x - CIRCLE_WIDTH/2, pos.y - CIRCLE_WIDTH/2).
  // That puts the disk center exactly at (pos.x, pos.y) for every node,
  // regardless of label length. The label extends to the right of the disk
  // in the same flex row but the disk's screen position is constant.
  //
  // Because the disk center is at (pos.x, pos.y), the edge anchor is just
  // (pos.x, pos.y) — no per-node measurement, no per-node offset, all
  // anchors at a consistent location relative to pos. Visible line is from
  // the disk's right edge to the target's disk's left edge (the in-disk
  // portion is hidden behind the higher-zIndex disk div).
  function getDiskAnchor(pos: Position): Position {
    return { x: pos.x, y: pos.y };
  }

  // Bounding box of every current node. Memoized on positionsTick so it
  // recomputes when the user drags, but stays stable between drag events.
  const bounds = useMemo(() => computeBounds(positionsRef.current), [
    positionsTick,
    // Recompute when the node set itself changes too.
    nodes,
  ]);

  // SVG size in graph space: bounds + padding. The SVG sits at (0, 0) of
  // the inner transformed div, so lines at absolute graph coordinates
  // (e.g. x1=200) are drawn at (200, 200) of the SVG, which corresponds
  // to (200, 200) in the inner div. As long as the SVG is large enough to
  // contain every line endpoint, the lines render.
  const svgWidth = Math.max(200, bounds.maxX - bounds.minX + 2 * EDGE_PADDING);
  const svgHeight = Math.max(200, bounds.maxY - bounds.minY + 2 * EDGE_PADDING);
  const svgLeft = bounds.minX - EDGE_PADDING;
  const svgTop = bounds.minY - EDGE_PADDING;

  // Global mousemove / mouseup listeners for the active drag (node OR pan).
  // Using a single useEffect with both states means only one set of
  // listeners at a time, and we attach/detach cleanly when drag ends.
  useEffect(() => {
    if (!drag && !panDrag) return;

    const handleMove = (e: MouseEvent) => {
      if (drag) {
        const screenDx = e.clientX - drag.startScreenX;
        const screenDy = e.clientY - drag.startScreenY;
        const dx = screenDx / zoom;
        const dy = screenDy / zoom;
        positionsRef.current.set(drag.nodeId, {
          x: drag.startNodeX + dx,
          y: drag.startNodeY + dy,
        });
        // Once the user has moved more than CLICK_THRESHOLD_PX, the gesture
        // is committed to a drag (and the click on mouseup is suppressed).
        if (!drag.moved && Math.hypot(screenDx, screenDy) >= CLICK_THRESHOLD_PX) {
          setDrag({ ...drag, moved: true });
        }
        // Re-render with new positions.
        setPositionsTick((t) => t + 1);
      } else if (panDrag) {
        const dx = e.clientX - panDrag.startScreenX;
        const dy = e.clientY - panDrag.startScreenY;
        setPan({ x: panDrag.startPanX + dx, y: panDrag.startPanY + dy });
      }
    };

    const handleUp = () => {
      if (drag && !drag.moved) {
        // Treat as a click: open the drawer.
        const target = nodes.find((n) => n.id === drag.nodeId);
        if (target && onNodeClick) onNodeClick(target);
      }
      setDrag(null);
      setPanDrag(null);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [drag, panDrag, zoom, nodes, onNodeClick]);

  // Wheel zoom. Bound to the container (not window) so scrolling the page
  // itself still works.
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    setZoom((z) => {
      const next = e.deltaY > 0 ? z * 0.9 : z * 1.1;
      return Math.max(0.2, Math.min(3, next));
    });
  }, []);

  // Canvas mousedown starts a pan (when the user clicks empty space).
  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only start panning when the user clicks the container itself, not
      // bubbled clicks from nodes (which stop propagation in their handler).
      if (e.target !== e.currentTarget) return;
      setPanDrag({
        startScreenX: e.clientX,
        startScreenY: e.clientY,
        startPanX: pan.x,
        startPanY: pan.y,
      });
    },
    [pan]
  );

  // Node mousedown starts a drag. `e.stopPropagation()` so the canvas
  // doesn't also see this as a pan-start.
  const handleNodeMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, node: GraphNode) => {
      e.stopPropagation();
      const pos = getPosition(node.id);
      setDrag({
        nodeId: node.id,
        startScreenX: e.clientX,
        startScreenY: e.clientY,
        startNodeX: pos.x,
        startNodeY: pos.y,
        moved: false,
      });
    },
    [getPosition]
  );

  // Control button handlers.
  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(3, z * 1.2));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(0.2, z / 1.2));
  }, []);

  const handleReset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Fit the entire graph into the visible viewport with a small margin.
  // Reads the container's current clientWidth/clientHeight at call time.
  const handleFit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w <= 0 || h <= 0) return;
    const bw = Math.max(1, bounds.maxX - bounds.minX);
    const bh = Math.max(1, bounds.maxY - bounds.minY);
    const margin = 40;
    const fitZoom = Math.max(
      0.2,
      Math.min(3, Math.min((w - 2 * margin) / bw, (h - 2 * margin) / bh))
    );
    setZoom(fitZoom);
    // Center the bounds within the viewport at that zoom.
    const cx = bounds.minX + bw / 2;
    const cy = bounds.minY + bh / 2;
    setPan({
      x: w / 2 - cx * fitZoom,
      y: h / 2 - cy * fitZoom,
    });
  }, [bounds]);

  // Build the dashed/dotted background grid pattern as a single SVG. We use
  // a <pattern> with a single dot per cell; the pattern is then painted as
  // the fill of a rect that covers the entire SVG area. This is the same
  // approach xyflow's <Background> uses, and is GPU-cheap because the
  // pattern tile is small.
  // The grid pans/zooms with the parent transform, no extra work.
  const gridPatternId = "graph-grid-pattern";

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, position: "relative", overflow: "hidden" }}
    >
      {/* Top-left counter. */}
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          zIndex: 10,
          padding: "4px 8px",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          fontSize: 12,
          pointerEvents: "none",
        }}
      >
        节点 {nodes.length} / {total}
        {truncated && " (已截断)"} · 边 {edges.length}
      </div>
      {/* Top-right zoom indicator. */}
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: 10,
          padding: "4px 8px",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          fontSize: 12,
          fontFamily: "monospace",
          pointerEvents: "none",
        }}
      >
        zoom {(zoom * 100).toFixed(0)}%
      </div>
      {/* Canvas (listens for pan-start, wheel for zoom). */}
      <div
        onMouseDown={handleCanvasMouseDown}
        onWheel={handleWheel}
        style={{
          position: "absolute",
          inset: 0,
          background: "var(--bg)",
          // "grabbing" when a pan is active OR a node is being dragged, so the
          // user gets visual feedback that the gesture is engaged.
          cursor: panDrag || drag ? "grabbing" : "grab",
        }}
      >
        {/* Inner transformed layer. transform-origin: 0 0 anchors the
            scale at top-left so translate + scale compose predictably. */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            transformOrigin: "0 0",
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            // Layer ordering: SVG edges below node divs so the colored
            // circles stay crisp on top.
          }}
        >
          {/* Background grid (single SVG, painted with a tile pattern).
              We position the SVG at the bounds top-left + padding so its
              local (0,0) is at graph (svgLeft, svgTop). The rect is then
              drawn at (0,0) within the SVG. This keeps the pattern's
              userSpaceOnUse tile aligned to graph space (20px per cell),
              and gives the SVG a real positive size so the pattern actually
              paints (a 0x0 SVG silently drops children — the bug we hit
              on the edge layer before the rewrite). */}
          <svg
            style={{
              position: "absolute",
              left: svgLeft,
              top: svgTop,
              overflow: "visible",
              pointerEvents: "none",
              zIndex: 0,
            }}
            width={svgWidth}
            height={svgHeight}
          >
            <defs>
              <pattern
                id={gridPatternId}
                width={GRID_SIZE}
                height={GRID_SIZE}
                patternUnits="userSpaceOnUse"
              >
                <circle cx={1} cy={1} r={1} fill="var(--border)" />
              </pattern>
            </defs>
            <rect
              x={0}
              y={0}
              width={svgWidth}
              height={svgHeight}
              fill={`url(#${gridPatternId})`}
            />
          </svg>
          {/* Edges (SVG under nodes). Same position+size as the grid SVG,
              so a line at graph (src.x, src.y) maps to SVG-local
              (src.x - svgLeft, src.y - svgTop). The SVG has a real
              positive size, and any line outside the viewport still
              renders thanks to overflow: visible. */}
          <svg
            style={{
              position: "absolute",
              left: svgLeft,
              top: svgTop,
              overflow: "visible",
              pointerEvents: "none",
              zIndex: 0,
            }}
            width={svgWidth}
            height={svgHeight}
          >
            {edges.map((e, i) => {
              const src = positionsRef.current.get(e.source);
              const tgt = positionsRef.current.get(e.target);
              if (!src || !tgt) return null;
              // Anchor at the disk center: the wrapper is positioned so
              // its 42px disk sits with center at (pos.x, pos.y), so the
              // anchor is just (pos.x, pos.y) for every node. Consistent
              // across all nodes regardless of label length.
              const srcAnchor = getDiskAnchor(src);
              const tgtAnchor = getDiskAnchor(tgt);
              const isAmbient = e.kind === "co_topic" || e.kind === "co_scope";
              return (
                <line
                  key={`e-${i}`}
                  x1={srcAnchor.x - svgLeft}
                  y1={srcAnchor.y - svgTop}
                  x2={tgtAnchor.x - svgLeft}
                  y2={tgtAnchor.y - svgTop}
                  stroke={edgeKindColor[e.kind]}
                  strokeWidth={isAmbient ? 1 : 1.5}
                  strokeDasharray={edgeKindDash[e.kind]}
                  opacity={isAmbient ? 0.5 : 0.9}
                />
              );
            })}
          </svg>
          {/* Nodes.
              The wrapper is positioned so the 42px disk sits with its
              top-left at (pos.x - CIRCLE_WIDTH/2, pos.y - CIRCLE_WIDTH/2).
              That puts the disk center at exactly (pos.x, pos.y) for every
              node, which is the edge anchor. The label extends to the right
              of the disk in the same flex row but the disk's screen
              position is constant. We don't translate(-50%, -50%) anymore
              because the disk — not the wrapper — is the reference point
              for layout and edge routing. */}
          {nodes.map((n) => {
            const pos = positionsRef.current.get(n.id);
            if (!pos) return null;
            return (
              <div
                key={n.id}
                onMouseDown={(e) => handleNodeMouseDown(e, n)}
                style={{
                  position: "absolute",
                  left: pos.x - CIRCLE_WIDTH / 2,
                  top: pos.y - CIRCLE_WIDTH / 2,
                  cursor: drag?.nodeId === n.id ? "grabbing" : "grab",
                  zIndex: 1,
                }}
              >
                <MemoryNode node={n} />
              </div>
            );
          })}
        </div>
      </div>
      {/* Floating UI (sits above the canvas, doesn't move with pan/zoom). */}
      <Controls
        zoom={zoom}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onFit={handleFit}
        onReset={handleReset}
      />
      <MiniMap nodes={nodes} edges={edges} positions={positionsRef.current} />
    </div>
  );
}
