import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrganizeButton } from "./OrganizeButton.js";

describe("OrganizeButton", () => {
  it("renders the 整理 label and a ✨ icon", () => {
    render(<OrganizeButton onOrganize={() => {}} busy={false} />);
    const btn = screen.getByRole("button", { name: /整理/ });
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain("✨");
  });
  it("calls onOrganize on click when not busy", () => {
    const cb = vi.fn();
    render(<OrganizeButton onOrganize={cb} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: /整理/ }));
    expect(cb).toHaveBeenCalledOnce();
  });
  it("does not call onOrganize when busy", () => {
    const cb = vi.fn();
    render(<OrganizeButton onOrganize={cb} busy={true} />);
    fireEvent.click(screen.getByRole("button", { name: /整理/ }));
    expect(cb).not.toHaveBeenCalled();
  });
  it("button is disabled when busy", () => {
    render(<OrganizeButton onOrganize={() => {}} busy={true} />);
    expect((screen.getByRole("button", { name: /整理/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
