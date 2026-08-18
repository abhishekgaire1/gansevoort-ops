/** Plain in-code dictionary normalizing common vendor-invoice unit
 * abbreviations to this schema's canonical `units.code` values -- the
 * global units vocabulary is tiny (under 10 codes today), so a persisted
 * alias table would be infrastructure in search of a problem. Returns the
 * input unchanged (uppercased) if it isn't a known alias -- callers treat
 * an unrecognized result as "unknown unit," never silently guess. */
const UNIT_ALIASES: Record<string, string> = {
  CS: "CASE",
  CASE: "CASE",
  BX: "BOX",
  BOX: "BOX",
  PK: "PACK",
  PACK: "PACK",
  PC: "PIECE",
  PCS: "PIECE",
  EA: "PIECE",
  EACH: "PIECE",
  BTL: "BOTTLE",
  BOTTLE: "BOTTLE",
  LB: "LB",
  LBS: "LB",
  POUND: "LB",
  POUNDS: "LB",
  OZ: "OZ",
  OUNCE: "OZ",
  OUNCES: "OZ",
  GAL: "GAL",
  GALLON: "GAL",
  GALLONS: "GAL",
  L: "L",
  LITER: "L",
  LITERS: "L",
  LITRE: "L",
};

export function normalizePurchaseUnitText(raw: string | null): string | null {
  if (!raw) return null;
  const key = raw.trim().toUpperCase();
  if (key.length === 0) return null;
  return UNIT_ALIASES[key] ?? key;
}
