interface CardGridSkeletonProps {
  count?: number;
  cardMinHeightClassName: string;
}

/**
 * Loading placeholder for the station/item card grids -- sized to
 * approximately match the loaded grid's dimensions (same grid-cols/gap and
 * the real card's own min-height) so the transition from "loading" to
 * "loaded" doesn't itself count as a layout jump.
 */
export function CardGridSkeleton({ count = 6, cardMinHeightClassName }: CardGridSkeletonProps) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className={`${cardMinHeightClassName} animate-pulse rounded-2xl border-2 border-kiosk-border bg-kiosk-surface`}
        />
      ))}
    </div>
  );
}
