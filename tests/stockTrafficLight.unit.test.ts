import { describe, expect, it } from "vitest";
import { stockTrafficLight, stockTrafficLightClass } from "@/app/lib/kiosk/stockTrafficLight";

// CI-safe: pure logic, no network, no database.

describe("stockTrafficLight", () => {
  it("maps FULL and HEALTHY to green -- the same computeStockGauge levels the manager page treats as healthy", () => {
    expect(stockTrafficLight("FULL")).toBe("green");
    expect(stockTrafficLight("HEALTHY")).toBe("green");
  });

  it("maps MEDIUM to yellow", () => {
    expect(stockTrafficLight("MEDIUM")).toBe("yellow");
  });

  it("maps LOW and EMPTY to red -- the kiosk grid's own positive-balance filter means EMPTY should never actually occur on a real card, but the mapping stays correct regardless", () => {
    expect(stockTrafficLight("LOW")).toBe("red");
    expect(stockTrafficLight("EMPTY")).toBe("red");
  });

  it("maps null (no full-stock reference set) to neutral -- never guessed as green or red", () => {
    expect(stockTrafficLight(null)).toBe("neutral");
  });
});

describe("stockTrafficLightClass", () => {
  it("returns a distinct Tailwind class for every light", () => {
    const classes = (["green", "yellow", "red", "neutral"] as const).map(stockTrafficLightClass);
    expect(new Set(classes).size).toBe(4);
  });
});
