// Task 15: graph route skeleton. Components are wired in by Task 16 (MemoryNode)
// and Task 18 (GraphCanvas + common + legend + poll indicator).
// Task 25: add click-to-drawer UX. Selected node state lives here so the
// drawer survives GraphCanvas re-renders from polling.
// Task 10 (v0.2): FilterBar v0.2 owns OrgModeSwitcher + OrganizeButton + refresh
// in its second row. We pass `organization` (lifted from the filter for layout)
// and a top-level organize handler.
// Task 11 (v0.2): `handleOrganize` actually re-layouts by bumping `organizeTick`
// and remounting GraphCanvas via `key={organizeTick}`; `useEffect` listens for
// the `locate-node` / `jump-to-node` window events that MemoryDrawer dispatches.
import { useCallback, useEffect, useState } from "react";
import { useGraph } from "../lib/useGraph.js";
import { usePolling } from "../lib/usePolling.js";
import type { GraphFilter, GraphNode, OrgMode } from "@agent-recall/contracts";
import GraphCanvas from "../components/graph/GraphCanvas.js";
import FilterBar from "../components/graph/FilterBar.js";
import EdgeLegend from "../components/graph/EdgeLegend.js";
import EmptyState from "../components/common/EmptyState.js";
import ErrorBanner from "../components/common/ErrorBanner.js";
import PollIndicator from "../components/common/PollIndicator.js";
import MemoryDrawer from "../components/graph/MemoryDrawer.js";

export default function GraphPage() {
  const [filter, setFilter] = useState<GraphFilter>({
    scope: "all",
    status: ["active"],
    max_nodes: 500,
    include_co_topic: true,
    include_co_scope: false,
    organization: "none",
  });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  // Bumped by handleOrganize; used as the key for <GraphCanvas> so React
  // remounts the canvas, which re-runs the useMemo for the layout and resets
  // any user-dragged positions. The route-level busy flag gives the button
  // its spinner.
  const [organizeTick, setOrganizeTick] = useState(0);
  const [organizeBusy, setOrganizeBusy] = useState(false);
  const { data, error, isLoading, refetch } = useGraph(filter);
  const { status } = usePolling(refetch);

  // 监听 MemoryDrawer 派发的 window event
  useEffect(() => {
    const onLocate = (_e: Event) => {
      // v0.2 简化:只关 drawer,canvas pan/高亮留 v0.3
      setSelectedNode(null);
    };
    const onJump = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      if (!id || !data) return;
      const node = data.nodes.find((n) => n.id === id);
      if (node) setSelectedNode(node);
    };
    window.addEventListener("locate-node", onLocate);
    window.addEventListener("jump-to-node", onJump);
    return () => {
      window.removeEventListener("locate-node", onLocate);
      window.removeEventListener("jump-to-node", onJump);
    };
  }, [data]);

  const handleOrganize = useCallback(() => {
    setOrganizeBusy(true);
    setOrganizeTick((t) => t + 1);
    setTimeout(() => setOrganizeBusy(false), 200);
  }, []);

  const handleOrganizationChange = useCallback((m: OrgMode) => {
    setFilter((prev) => ({ ...prev, organization: m }));
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ display: "flex", alignItems: "center", background: "var(--bg-elev)" }}>
        <FilterBar
          filter={filter}
          onChange={setFilter}
          onRefresh={refetch}
          organization={filter.organization ?? "none"}
          onOrganizationChange={handleOrganizationChange}
          onOrganize={handleOrganize}
          organizeBusy={organizeBusy}
        />
        <PollIndicator status={status} />
      </div>
      <EdgeLegend />
      {error && <ErrorBanner error={error} />}
      {isLoading && <div style={{ padding: 12 }}>加载中…</div>}
      {!isLoading && data && data.nodes.length === 0 && (
        <EmptyState message="数据库为空或过滤过严" />
      )}
      {data && data.nodes.length > 0 && (
        <GraphCanvas
          key={organizeTick}
          nodes={data.nodes}
          edges={data.edges}
          truncated={data.truncated}
          total={data.total}
          organization={filter.organization ?? "none"}
          onNodeClick={setSelectedNode}
        />
      )}
      <MemoryDrawer node={selectedNode} onClose={() => setSelectedNode(null)} />
    </div>
  );
}
