import { describe, expect, it } from "vitest";
import { getDisplayNameError } from "./profile";

describe("getDisplayNameError", () => {
  it("requires a non-empty display name", () => {
    expect(getDisplayNameError("   ")).toBe("Enter a display name.");
  });

  it("limits display names to 80 characters", () => {
    expect(getDisplayNameError("a".repeat(81))).toBe(
      "Display names must be 80 characters or fewer.",
    );
  });

  it("accepts a trimmed display name within the limit", () => {
    expect(getDisplayNameError(" Alex ")).toBeNull();
  });
});
