/**
 * Vendor-classification presentation -- pure helpers shared by every
 * vendor picker/badge so the wording can never drift between surfaces.
 * "Inventory" / "Non-inventory" deliberately matches the item-side
 * disposition vocabulary the classification form already uses
 * (ItemClassificationForms.tsx) -- one consistent identity language.
 */

export type VendorClassificationValue = "INVENTORY" | "NON_INVENTORY";

export function vendorClassificationLabel(classification: VendorClassificationValue): string {
  return classification === "NON_INVENTORY" ? "Non-inventory" : "Inventory";
}

/**
 * Picker <option> label. Only NON_INVENTORY vendors get the suffix --
 * inventory suppliers are the norm on receiving surfaces, and badging
 * every row would say nothing.
 */
export function vendorOptionLabel(vendor: { name: string; classification: VendorClassificationValue }): string {
  return vendor.classification === "NON_INVENTORY" ? `${vendor.name} — Non-inventory` : vendor.name;
}
