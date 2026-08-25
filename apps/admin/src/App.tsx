import { MemoryRouter, Routes, Route } from "react-router-dom";
import GraphPage from "./routes/graph.js";

export default function App() {
  return (
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<GraphPage />} />
      </Routes>
    </MemoryRouter>
  );
}
