// Task 15: graph route skeleton. Components are wired in by Task 16 (MemoryNode)
// and Task 18 (GraphCanvas + common + legend + poll indicator).
// Task 25: add click-to-drawer UX. Selected node state lives here so the
// drawer survives GraphCanvas re-renders from polling.
import { useState } from "react";
import { useGraph } from "../lib/useGraph.js";
import { usePolling } from "../lib/usePolling.js";
import type { GraphFilter, GraphNode } from "@agent-recall/contracts";
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
  const { data, error, isLoading, refetch } = useGraph(filter);
  const { status } = usePolling(refetch);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ display: "flex", alignItems: "center", background: "var(--bg-elev)" }}>
        <FilterBar filter={filter} onChange={setFilter} onRefresh={refetch} />
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
          nodes={data.nodes}
          edges={data.edges}
          truncated={data.truncated}
          total={data.total}
          organization={filter.organization}
          onNodeClick={setSelectedNode}
        />
      )}
      <MemoryDrawer node={selectedNode} onClose={() => setSelectedNode(null)} />
    </div>
  );
}
