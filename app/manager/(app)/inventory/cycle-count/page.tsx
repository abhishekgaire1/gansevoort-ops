import { CycleCountHub } from "../_components/CycleCountHub";

/**
 * The Cycle Count hub/history landing page (Part "CYCLE COUNT LANDING
 * PAGE") -- no longer immediately starts a count. "+ New Cycle Count"
 * routes to /cycle-count/new for location selection; "Resume"/"View
 * Details" route to /cycle-count/[id] for a specific count.
 */
export default function CycleCountPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <CycleCountHub />
    </div>
  );
}
