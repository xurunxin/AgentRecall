import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemorySource } from "./MemorySource.js";

describe("MemorySource", () => {
  it("is collapsed by default and shows toggle", () => {
    render(<MemorySource source={{ kind: "user", ref: "claude" }} />);
    expect(screen.getByRole("button", { name: /展开/i })).toBeTruthy();
    expect(screen.queryByText(/"kind"/)).toBe(null);
  });
  it("expands on click and shows JSON", () => {
    render(<MemorySource source={{ kind: "user", ref: "claude" }} />);
    fireEvent.click(screen.getByRole("button", { name: /展开/i }));
    expect(screen.getByText(/"kind"/)).toBeTruthy();
  });
});
