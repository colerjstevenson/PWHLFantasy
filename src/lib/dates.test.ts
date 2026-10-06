import { afterEach, describe, expect, it, vi } from "vitest";
import { formatEastern } from "./dates";

const DateTimeFormat = Intl.DateTimeFormat;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatEastern", () => {
  it.each([
    ["2026-10-05T23:00:00Z", "Oct 5, 2026, 7:00 PM EDT"],
    ["2026-12-01T00:00:00Z", "Nov 30, 2026, 7:00 PM EST"],
    ["2026-03-08T06:59:00Z", "Mar 8, 2026, 1:59 AM EST"],
    ["2026-03-08T07:00:00Z", "Mar 8, 2026, 3:00 AM EDT"],
  ])(
    "formats %s with valid options and the Eastern zone",
    (value, expected) => {
      vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
        function (_locales, options) {
          return new DateTimeFormat("en-US", options);
        },
      );

      expect(formatEastern(value)).toBe(expected);
      expect(Intl.DateTimeFormat).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          timeZone: "America/New_York",
          timeZoneName: "short",
        }),
      );
    },
  );
});
