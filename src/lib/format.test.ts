import { describe, expect, it } from "vitest";
import { formatError, shortAddress, stellarFromStroops } from "./format";

describe("BountyFlow formatting", () => {
  it("shortens contract and wallet addresses", () => expect(shortAddress("GABCDEF123456789XYZ")).toBe("GABCD…89XYZ"));
  it("formats stroops as XLM", () => expect(stellarFromStroops(25_000_000)).toBe("2.50"));
  it("keeps useful transaction errors", () => expect(formatError(new Error("simulation failed: insufficient balance"))).toContain("insufficient balance"));
  it("handles non-error values", () => expect(formatError("wallet rejected")).toBe("wallet rejected"));
});
