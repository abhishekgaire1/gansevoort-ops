"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Lets a specific page (the purchase-document workflow, where "Continue
 * to Review & Post" must stay the visually dominant action) ask the
 * globally-mounted AskGansevoortLauncher (ManagerShell.tsx) to render its
 * restrained/compact treatment instead of the default bright pill --
 * without prop-drilling through every layout between them. The state
 * lives here, in ManagerShell (the launcher's own parent); a descendant
 * page never renders the launcher itself, only requests a density via
 * useCompactAskGansevoort().
 */
type Density = "normal" | "compact";

const DensityValueContext = createContext<Density>("normal");
const DensitySetterContext = createContext<((density: Density) => void) | null>(null);

export function AskGansevoortDensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensity] = useState<Density>("normal");
  const setter = useMemo(() => setDensity, []);
  return (
    <DensitySetterContext.Provider value={setter}>
      <DensityValueContext.Provider value={density}>{children}</DensityValueContext.Provider>
    </DensitySetterContext.Provider>
  );
}

/** Read by AskGansevoortLauncher only. */
export function useAskGansevoortDensity(): Density {
  return useContext(DensityValueContext);
}

/** Called by a workflow page (e.g. the purchase-document Steps 1-3
 * wizard) to request the compact launcher treatment for as long as it
 * stays mounted -- reverting to "normal" the instant it unmounts
 * (navigating away), never a setting that leaks onto an unrelated page. */
export function useCompactAskGansevoort() {
  const setDensity = useContext(DensitySetterContext);
  useEffect(() => {
    if (!setDensity) return;
    setDensity("compact");
    return () => setDensity("normal");
  }, [setDensity]);
}
