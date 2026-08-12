import type { ReactNode } from "react";

interface KioskScreenProps {
  /** Fixed/non-scrolling top region: screen title, back/error banner,
   * search + category chips -- whatever must always stay visible. */
  header?: ReactNode;
  /** Fixed/non-scrolling bottom region: the primary Continue/Confirm
   * action. Rendered as an ordinary flex sibling below the scroll region
   * (not position:sticky) -- since the page itself never scrolls (see
   * KioskShell), a plain flex child at the end of the column is already
   * always visible, with no overlay/backdrop-blur tricks needed. */
  footer?: ReactNode;
  /** The genuinely scrollable body -- only this region scrolls. */
  children: ReactNode;
  /** Vertically centers the body content within the available space
   * instead of top-aligning it -- for a single-cluster screen (e.g. the
   * quantity value card + keypad) rather than a list/grid. */
  centerBody?: boolean;
}

/**
 * Standard fixed-header / scrollable-body / fixed-footer frame for every
 * post-PIN kiosk screen (see the kiosk scrolling-system requirements).
 * min-h-0 at every level in this flex chain is load-bearing: without it,
 * the scrollable body would grow to fit its content instead of clipping to
 * the space actually available, and header/footer would never truly stay
 * fixed.
 */
export function KioskScreen({ header, footer, children, centerBody = false }: KioskScreenProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header ? <div className="shrink-0">{header}</div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
        <div className={centerBody ? "flex min-h-full flex-col items-center justify-center gap-6 py-4" : "py-4"}>
          {children}
        </div>
      </div>
      {footer ? <div className="shrink-0 border-t border-kiosk-border pb-6 pt-4 sm:pb-8">{footer}</div> : null}
    </div>
  );
}
