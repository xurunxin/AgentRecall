import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryBody } from "./MemoryBody.js";

describe("MemoryBody", () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("renders the body text in a <pre>", () => {
    render(<MemoryBody body="hello world" />);
    const pre = screen.getByText("hello world");
    expect(pre.tagName).toBe("PRE");
  });

  it("copies body to clipboard when 复制 button clicked", async () => {
    render(<MemoryBody body="copy me" />);
    const btn = screen.getByRole("button", { name: /复制/i });
    fireEvent.click(btn);
    await Promise.resolve(); // let the microtask resolve
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("copy me");
  });
});
