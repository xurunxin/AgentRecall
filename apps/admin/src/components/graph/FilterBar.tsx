// Task 15 placeholder stub. Real FilterBar lands in Task 17.
// See: .superpowers/sdd/2026-08-24-agent-recall-admin-v0.1/task-17-brief.md
import type { GraphFilter } from "@agent-recall/contracts";

export interface FilterBarProps {
  filter: GraphFilter;
  onChange: (next: GraphFilter) => void;
  onRefresh: () => void;
}

export default function FilterBar(_props: FilterBarProps): null {
  return null;
}
