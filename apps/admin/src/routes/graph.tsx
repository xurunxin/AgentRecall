// Task 15: graph route skeleton. Components are wired in by Task 16 (MemoryNode)
// and Task 18 (GraphCanvas + common + legend + poll indicator).
import { useState } from "react";
import { useGraph } from "../lib/useGraph.js";
import type { GraphFilter } from "@agent-recall/contracts";
import GraphCanvas from "../components/graph/GraphCanvas.js";
import FilterBar from "../components/graph/FilterBar.js";
import EdgeLegend from "../components/graph/EdgeLegend.js";
import EmptyState from "../components/common/EmptyState.js";
import ErrorBanner from "../components/common/ErrorBanner.js";
import PollIndicator from "../components/common/PollIndicator.js";

export default function GraphPage() {
  const [filter, setFilter] = useState<GraphFilter>({
    scope: "all",
    status: ["active"],
    max_nodes: 500,
    include_co_topic: true,
    include_co_scope: false,
  });
  const { data, error, isLoading, refetch } = useGraph(filter);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ display: "flex", alignItems: "center", background: "var(--bg-elev)" }}>
        <FilterBar filter={filter} onChange={setFilter} onRefresh={refetch} />
        <PollIndicator status="idle" />
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
        />
      )}
    </div>
  );
}
