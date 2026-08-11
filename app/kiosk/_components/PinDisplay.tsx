interface PinDisplayProps {
  length: number;
  filled: number;
}

/** Shows filled/empty dots only -- never the digits themselves. */
export function PinDisplay({ length, filled }: PinDisplayProps) {
  return (
    <div
      className="flex items-center justify-center gap-4"
      role="status"
      aria-label={`${filled} of ${length} digits entered`}
    >
      {Array.from({ length }).map((_, index) => (
        <span
          key={index}
          className={`h-5 w-5 rounded-full border-2 transition ${
            index < filled ? "border-amber-400 bg-amber-400" : "border-zinc-600 bg-transparent"
          }`}
        />
      ))}
    </div>
  );
}
