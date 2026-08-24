// Task 15: graph route (skeleton). Components imported below are stubs added in
// this task as placeholders; their real implementations land in Task 16-18.
import { useState } from "react";
import { useGraph } from "../lib/useGraph.js";
import type { GraphFilter } from "@agent-recall/contracts";
import GraphCanvas from "../components/graph/GraphCanvas.js";
import FilterBar from "../components/graph/FilterBar.js";
import EmptyState from "../components/common/EmptyState.js";
import ErrorBanner from "../components/common/ErrorBanner.js";

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
      <FilterBar filter={filter} onChange={setFilter} onRefresh={refetch} />
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
