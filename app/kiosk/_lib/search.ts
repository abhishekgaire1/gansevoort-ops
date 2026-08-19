/**
 * Kiosk smart/fuzzy search (Milestone 2A.5 Part D). Pure logic, no
 * network, no database -- runs entirely client-side over the already-
 * fetched, already-small (dozens of rows for a real org) currently-
 * withdrawable item list, so search is instant and works with no extra
 * round trip per keystroke.
 *
 * Trusted signals only (§16): the item's own canonical name, plus
 * CONFIRMED, active vendor SKUs/descriptions (app/lib/kiosk/searchSignals.ts
 * -- sourced from vendor_item_mappings, which already excludes pending AI
 * suggestions). No Gemini/AI call is ever made for a live kiosk search.
 */

export interface SearchCandidateItem {
  id: string;
  name: string;
  categoryName: string;
  vendorSkus: string[];
  vendorDescriptions: string[];
}

/** Lowercase, &/and-equivalent, punctuation-insensitive, whitespace-collapsed. */
export function normalizeSearchText(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokenize(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(" ");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previousRow = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const currentRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(Math.min(currentRow[j - 1] + 1, previousRow[j] + 1, previousRow[j - 1] + cost));
    }
    previousRow = currentRow;
  }
  return previousRow[b.length];
}

/** Short tokens tolerate one typo; longer tokens tolerate two. */
function typoThreshold(tokenLength: number): number {
  return tokenLength <= 4 ? 1 : 2;
}

/** Adjacent-token concatenations, so "oat"+"milk" also matches a glued
 * query token like "oatmilk", and "64"+"oz" also matches "64oz". */
function withAdjacentPairs(tokens: string[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    pairs.push(tokens[i] + tokens[i + 1]);
  }
  return [...tokens, ...pairs];
}

/**
 * Every query token must match something in targetTokens -- exactly (or
 * as a glued adjacent-pair) for "TOKEN", within typo tolerance for
 * "FUZZY" -- or the whole target is not a match at all (null). The
 * overall result is the weakest tier any single query token needed.
 */
function tokensMatchTarget(queryTokens: string[], targetTokens: string[]): "TOKEN" | "FUZZY" | null {
  if (queryTokens.length === 0 || targetTokens.length === 0) return null;
  const expanded = withAdjacentPairs(targetTokens);
  let worstTier: "TOKEN" | "FUZZY" = "TOKEN";

  for (const queryToken of queryTokens) {
    if (expanded.includes(queryToken)) continue;

    let bestDistance = Infinity;
    for (const targetToken of targetTokens) {
      const distance = levenshtein(queryToken, targetToken);
      if (distance < bestDistance) bestDistance = distance;
    }

    if (bestDistance <= typoThreshold(queryToken.length)) {
      worstTier = "FUZZY";
    } else {
      return null;
    }
  }

  return worstTier;
}

type MatchTier = "EXACT" | "PREFIX" | "TOKEN" | "VENDOR_DESCRIPTION" | "EXACT_SKU" | "CATEGORY" | "FUZZY";

const TIER_RANK: Record<MatchTier, number> = {
  EXACT: 0,
  PREFIX: 1,
  TOKEN: 2,
  VENDOR_DESCRIPTION: 3,
  EXACT_SKU: 4,
  CATEGORY: 5,
  FUZZY: 6,
};

/**
 * Ranks candidates against a raw query per §19: exact canonical name >
 * canonical prefix > canonical token (incl. typo/glued-word tolerance) >
 * confirmed vendor-description match > exact vendor SKU > category >
 * fuzzy canonical-name match. Candidates matching nothing are excluded
 * entirely -- this never pads results with irrelevant items.
 */
export function rankSearchResults<T extends SearchCandidateItem>(items: T[], rawQuery: string): T[] {
  const normalizedQuery = normalizeSearchText(rawQuery);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = tokenize(normalizedQuery);

  const scored: { item: T; tier: number }[] = [];

  for (const item of items) {
    const normalizedName = normalizeSearchText(item.name);
    let bestTier: MatchTier | null = null;

    if (normalizedName === normalizedQuery) {
      bestTier = "EXACT";
    } else if (normalizedName.startsWith(normalizedQuery)) {
      bestTier = "PREFIX";
    } else {
      const nameMatch = tokensMatchTarget(queryTokens, tokenize(normalizedName));
      if (nameMatch !== null) bestTier = nameMatch === "TOKEN" ? "TOKEN" : "FUZZY";
    }

    if (bestTier === null || bestTier === "FUZZY") {
      for (const description of item.vendorDescriptions) {
        if (tokensMatchTarget(queryTokens, tokenize(normalizeSearchText(description))) === "TOKEN") {
          bestTier = "VENDOR_DESCRIPTION";
          break;
        }
      }
    }

    if (bestTier === null || bestTier === "FUZZY") {
      for (const sku of item.vendorSkus) {
        if (normalizeSearchText(sku) === normalizedQuery) {
          bestTier = "EXACT_SKU";
          break;
        }
      }
    }

    if (bestTier === null || bestTier === "FUZZY") {
      if (tokensMatchTarget(queryTokens, tokenize(normalizeSearchText(item.categoryName))) === "TOKEN") {
        bestTier = "CATEGORY";
      }
    }

    if (bestTier === null) continue;
    scored.push({ item, tier: TIER_RANK[bestTier] });
  }

  scored.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.item.name.localeCompare(b.item.name)));
  return scored.map((s) => s.item);
}
