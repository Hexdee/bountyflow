import { describe, expect, it } from "vitest";
import { badgeName, formatError, shortAddress } from "./format";

describe("format helpers", () => {
  it("shortens Stellar addresses without losing their edges", () => {
    expect(shortAddress("GDLLMOUYQ655IMYFO56ITZLLSX57ZTNKD67GA723E7GMCZJHXJBFXNID")).toBe("GDLLM…FXNID");
  });

  it("maps activity levels to builder badges", () => {
    expect(badgeName(0)).toBe("Unranked");
    expect(badgeName(2)).toBe("Orange Builder");
    expect(badgeName(3)).toBe("Master Builder");
  });

  it("normalizes unknown errors", () => {
    expect(formatError(new Error("RPC unavailable"))).toBe("RPC unavailable");
    expect(formatError({})).toBe("Something went wrong. Try again.");
  });
});
