interface ReviewRow {
  label: string;
  value: string;
}

interface ReviewCardProps {
  rows: ReviewRow[];
}

/** Generic label/value summary -- deliberately never shows pricing, cost,
 * or any HIGH_WITHDRAWAL/threshold hint (that logic never reaches the
 * employee-facing UI at all). */
export function ReviewCard({ rows }: ReviewCardProps) {
  return (
    <dl className="divide-y divide-kiosk-border rounded-2xl border border-kiosk-border bg-kiosk-surface">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-4 px-6 py-4">
          <dt className="text-base text-kiosk-text-muted">{row.label}</dt>
          <dd className="text-right text-xl font-medium text-kiosk-text">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
