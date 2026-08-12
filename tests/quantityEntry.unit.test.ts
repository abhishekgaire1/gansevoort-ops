import { describe, expect, it } from "vitest";
import { isValidWithdrawalQuantity } from "@/app/kiosk/_lib/quantityEntry";

// CI-safe: pure logic, no network, no database.

describe("isValidWithdrawalQuantity", () => {
  it("is true for a positive number", () => {
    expect(isValidWithdrawalQuantity("43.6")).toBe(true);
    expect(isValidWithdrawalQuantity("210")).toBe(true);
  });

  it("supports fractional quantities", () => {
    expect(isValidWithdrawalQuantity("0.5")).toBe(true);
  });

  it("is false for zero, empty, or non-numeric input", () => {
    expect(isValidWithdrawalQuantity("0")).toBe(false);
    expect(isValidWithdrawalQuantity("")).toBe(false);
    expect(isValidWithdrawalQuantity("   ")).toBe(false);
    expect(isValidWithdrawalQuantity("abc")).toBe(false);
  });

  it("is false for a negative number", () => {
    expect(isValidWithdrawalQuantity("-1")).toBe(false);
  });
});
