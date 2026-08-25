import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { OrgMode } from "@agent-recall/contracts";
import { OrgModeSwitcher } from "./OrgModeSwitcher.js";

describe("OrgModeSwitcher", () => {
  it("renders 4 mode options + a no-mode option", () => {
    const onChange = vi.fn();
    render(<OrgModeSwitcher value="none" onChange={onChange} />);
    expect(screen.getByRole("radio", { name: /无/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /按主题/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /按类型/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /按 scope/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /按状态/ })).toBeTruthy();
  });
  it("calls onChange when a different option is selected", () => {
    const onChange = vi.fn();
    render(<OrgModeSwitcher value="none" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /按主题/ }));
    expect(onChange).toHaveBeenCalledWith("by_topic" satisfies OrgMode);
  });
  it("the current value's radio is checked", () => {
    render(<OrgModeSwitcher value="by_type" onChange={() => {}} />);
    expect((screen.getByRole("radio", { name: /按类型/ }) as HTMLInputElement).checked).toBe(true);
  });
});
