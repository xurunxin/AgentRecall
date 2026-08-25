import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryTags } from "./MemoryTags.js";

describe("MemoryTags", () => {
  it("renders one pill per tag", () => {
    render(<MemoryTags tags={["auth", "jwt", "rfc7519"]} />);
    expect(screen.getByText("auth")).toBeTruthy();
    expect(screen.getByText("jwt")).toBeTruthy();
    expect(screen.getByText("rfc7519")).toBeTruthy();
  });
  it("shows em-dash when tags array is empty", () => {
    render(<MemoryTags tags={[]} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});
