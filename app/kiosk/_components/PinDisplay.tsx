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
            index < filled ? "border-kiosk-amber bg-kiosk-amber" : "border-kiosk-border-strong bg-transparent"
          }`}
        />
      ))}
    </div>
  );
}
