"use client";

interface KioskHeaderProps {
  title: string;
  onBack?: () => void;
  onStartOver?: () => void;
}

export function KioskHeader({ title, onBack, onStartOver }: KioskHeaderProps) {
  return (
    <div className="mb-8 flex items-center justify-between gap-4">
      <div className="flex items-center gap-4">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="rounded-full px-4 py-3 text-lg font-medium text-zinc-300 transition hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            ← Back
          </button>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl">{title}</h1>
      </div>
      {onStartOver ? (
        <button
          type="button"
          onClick={onStartOver}
          className="shrink-0 rounded-full border border-zinc-700 px-5 py-3 text-base font-medium text-zinc-300 transition hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
        >
          Start Over
        </button>
      ) : null}
    </div>
  );
}
