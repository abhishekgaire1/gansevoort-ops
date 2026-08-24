import { CycleCountView } from "../../_components/CycleCountView";

/**
 * "+ New Cycle Count" from the hub -- location selection only (Part "NEW
 * CYCLE COUNT"). CycleCountView defaults to its pick_location step when
 * given no initialCountId. Resuming/counting/reviewing all happen in
 * place here without a further route change, same as before this
 * milestone -- only entry (via the hub, not directly on /manager/inventory)
 * and history/detail viewing (via /cycle-count/[id]) are new.
 */
export default function NewCycleCountPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <CycleCountView />
    </div>
  );
}
