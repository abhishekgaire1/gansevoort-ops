/**
 * The ONE way a field/row-level problem is shown anywhere in Receiving
 * (Receiving UX Interaction System pass) -- directly under/beside the
 * control that has the problem, never collected into a detached box
 * elsewhere on the page. Toasts are for network/save results, not this.
 */
export function InlineValidationMessage({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <p id={id} role="alert" className="mt-1 flex items-start gap-1 text-xs text-amber-400">
      <span aria-hidden="true">⚠</span>
      <span>{children}</span>
    </p>
  );
}
