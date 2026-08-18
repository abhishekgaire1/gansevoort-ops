export type ReceiptKind = "DELIVERY" | "CORRECTION";

export type ReceiptLineConditionStatus = "RECEIVED_AS_INVOICED" | "SHORT" | "DAMAGED" | "WRONG_ITEM" | "NOT_RECEIVED" | "EXCESS" | "OTHER";

export interface ReceiptLineInput {
  lineNumberSnapshot: number | null;
  matchedLineKey: string | null;
  vendorSkuSnapshot: string | null;
  descriptionSnapshot: string | null;
  invoicePackageQuantity: number | null;
  invoicePackageUnit: string | null;
  invoiceMeasuredQuantity: number | null;
  invoiceMeasuredUnit: string | null;
  actualReceivedPackageQuantity: number | null;
  actualReceivedPackageUnit: string | null;
  actualVerifiedBaseQuantity: number | null;
  actualVerifiedBaseUnitId: string | null;
  locationId: string | null;
  conditionStatus?: ReceiptLineConditionStatus;
  notes?: string | null;
}
