import { useState } from "react";

export default function App() {
  const [count] = useState(0);
  return (
    <div style={{ padding: 24 }}>
      <h1>AgentRecall Admin (v0.1)</h1>
      <p>Monorepo 骨架已就位,等后续 task 接入 graph 视图。</p>
      <p>当前仅供 npm run dev 验证。count: {count}</p>
    </div>
  );
}
