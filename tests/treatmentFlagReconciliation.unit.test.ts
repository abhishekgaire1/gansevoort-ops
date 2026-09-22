import { describe, expect, it } from "vitest";
import { reconcileTreatmentFlags } from "@/app/lib/purchaseDocuments/treatmentFlagReconciliation";
import type { ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";

const flags: ReviewFlag[] = [
  { severity: "error", code: "LINE_NEGATIVE_TOTAL", field: "lines[0].lineTotal", message: "Line 1 has a negative line total." },
  { severity: "error", code: "LINE_NEGATIVE_UNIT_PRICE", field: "lines[0].unitPrice", message: "Line 1 has a negative unit price." },
  { severity: "error", code: "LINE_MISSING_PACKAGE_UNIT", field: "lines[0].packageUnit", message: "Line 1 has no unit." },
  { severity: "error", code: "LINE_NEGATIVE_TOTAL", field: "lines[1].lineTotal", message: "Line 2 has a negative line total." },
];
const lines = [{ lineKey: "credit" }, { lineKey: "unknown" }];

describe("reconcileTreatmentFlags", () => {
  it("drops negative-amount errors for a credit/discount line, keeps every other flag and every other line's flags", () => {
    const out = reconcileTreatmentFlags(flags, lines, new Map([["credit", "CREDIT_RETURN"]]));
    expect(out.map((f) => `${f.code}@${f.field}`)).toEqual(["LINE_MISSING_PACKAGE_UNIT@lines[0].packageUnit", "LINE_NEGATIVE_TOTAL@lines[1].lineTotal"]);
    expect(reconcileTreatmentFlags(flags, lines, new Map([["unknown", "DISCOUNT"]])).some((f) => f.field === "lines[1].lineTotal")).toBe(false);
  });

  it("an unresolved or expense line keeps its negative-amount flags", () => {
    expect(reconcileTreatmentFlags(flags, lines, new Map([["credit", "UNRESOLVED"]]))).toEqual(flags);
    expect(reconcileTreatmentFlags(flags, lines, new Map([["credit", "EXPENSE"]]))).toEqual(flags);
  });
});
