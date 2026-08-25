export default function InventoryAlertsLoading() {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="h-6 w-40 animate-pulse rounded bg-zinc-800" />
      <div className="mt-6 flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-900" />
        ))}
      </div>
    </div>
  );
}
