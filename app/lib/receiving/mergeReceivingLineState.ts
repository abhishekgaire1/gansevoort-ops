import { computeReceivingPrefill } from "@/app/lib/receiving/computeReceivingPrefill";
import type { ReceivingLineInfo } from "@/app/lib/receiving/getReceivingLines";

export interface LocationOption {
  id: string;
}

export interface ReceivingLineDraft {
  lineKey: string;
  info: ReceivingLineInfo;
  receivedQuantity: string;
  receivedUnit: string;
  verifiedQuantity: string;
  locationId: string;
  conditionStatus: "RECEIVED_AS_INVOICED" | "SHORT" | "DAMAGED" | "WRONG_ITEM" | "NOT_RECEIVED" | "EXCESS" | "OTHER";
  invoiceUnitChoice: string;
  rememberInvoiceUnit: boolean;
  invoiceUnitConflict: { invoiceUnit: string; rememberedUnit: string } | null;
}

/**
 * ReceivingPanel's Step 3 draft-state builder AND merger, in one place --
 * the single source of truth both the "Expected" display and the initial
 * "Received" draft value are derived from (computeReceivingPrefill), so
 * they can never disagree with each other the way a second, independent
 * fallback calculation could.
 *
 * Called on EVERY load (initial mount, poll, refetch after a submit,
 * another manager's confirmation landing) -- not just the first render.
 * A line seen for the first time is built fresh from whatever prefill is
 * currently safe. A line already present in `previous` NEVER has an
 * already-filled-in field overwritten -- convenience prefill is only ever
 * merged into a field that is STILL genuinely blank/pristine at merge
 * time. This is what makes both of these true simultaneously:
 *   - a safe prefill that only becomes available on a LATER load (e.g.
 *     the vendor's remembered invoice unit gets confirmed by another
 *     manager between polls) still reaches an untouched field, instead of
 *     being stuck blank forever because the line already existed once;
 *   - a manager's own edit (60 -> 58, or picking a location) is never
 *     silently reverted by a later poll/refetch, even one that arrives
 *     mid-edit.
 * "Pristine" is judged purely by the field's own current value being
 * blank ("") -- there is no separate touched/dirty flag to keep in sync,
 * which also means a manager who deliberately clears a field back to
 * blank is knowingly opting back into auto-prefill for it, not fighting
 * against a flag that silently overrides them.
 */
export function mergeReceivingLineState(lines: ReceivingLineInfo[], locations: LocationOption[], previous: ReceivingLineDraft[]): ReceivingLineDraft[] {
  const soleLocationId = locations.length === 1 ? locations[0].id : "";
  const previousByLineKey = new Map(previous.map((l) => [l.lineKey, l]));

  return lines
    .filter((info) => info.disposition === "INVENTORY")
    .map((info) => {
      const prefill = computeReceivingPrefill(info);
      const prior = previousByLineKey.get(info.lineKey);

      if (!prior) {
        return {
          lineKey: info.lineKey,
          info,
          receivedQuantity: prefill.receivedQuantity,
          receivedUnit: prefill.receivedUnit,
          verifiedQuantity: prefill.verifiedQuantity,
          locationId: info.defaultReceivingLocationId ?? soleLocationId,
          conditionStatus: "RECEIVED_AS_INVOICED",
          invoiceUnitChoice: "",
          rememberInvoiceUnit: true,
          invoiceUnitConflict: prefill.conflict,
        };
      }

      return {
        ...prior,
        info,
        receivedQuantity: prior.receivedQuantity.trim() === "" ? prefill.receivedQuantity : prior.receivedQuantity,
        receivedUnit: prior.receivedUnit.trim() === "" ? prefill.receivedUnit : prior.receivedUnit,
        verifiedQuantity: prior.verifiedQuantity.trim() === "" ? prefill.verifiedQuantity : prior.verifiedQuantity,
        locationId: prior.locationId.trim() === "" ? (info.defaultReceivingLocationId ?? soleLocationId) : prior.locationId,
        // Purely informational (never manager-edited directly) -- always
        // safe to refresh from the latest data.
        invoiceUnitConflict: prefill.conflict,
      };
    });
}
