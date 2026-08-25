import { describe, expect, it } from "vitest";
import { entityHref } from "@/app/lib/notifications/entityHref";

// CI-safe: pure function, no network, no database, no component render.

describe("entityHref -- builds routes only from trusted entityType/entityId, never a raw DB-supplied URL", () => {
  it("6. maps HIGH_WITHDRAWAL's entityType ('exception') to the alert detail page", () => {
    expect(entityHref({ entityType: "exception", entityId: "exc-1" })).toBe("/manager/inventory/alerts/exc-1");
  });

  it("9. existing routing for cycle-count notifications is unchanged", () => {
    expect(entityHref({ entityType: "inventory_cycle_count", entityId: "cc-1" })).toBe("/manager/inventory/cycle-count/cc-1");
  });

  it("9. existing routing for waste notifications is unchanged", () => {
    expect(entityHref({ entityType: "inventory_waste_event", entityId: "we-1" })).toBe("/manager/inventory/waste/we-1");
  });

  it("existing routing for purchase-document notifications is unchanged", () => {
    expect(entityHref({ entityType: "purchase_document", entityId: "pd-1" })).toBe("/manager/purchases/pd-1");
  });

  it("7. an unsupported/unknown entityType safely falls back to a no-op link, not a raw or broken URL", () => {
    expect(entityHref({ entityType: "some_future_entity_type", entityId: "x" })).toBe("#");
  });
});
