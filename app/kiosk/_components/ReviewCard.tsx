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
    <dl className="divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-4 px-6 py-4">
          <dt className="text-base text-zinc-400">{row.label}</dt>
          <dd className="text-right text-xl font-medium text-zinc-50">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
