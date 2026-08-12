"use client";

interface KioskHeaderProps {
  title: string;
  onBack?: () => void;
}

export function KioskHeader({ title, onBack }: KioskHeaderProps) {
  return (
    <div className="mb-4 flex items-center gap-4">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="rounded-full px-4 py-3 text-lg font-medium text-kiosk-text-muted transition hover:bg-kiosk-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
        >
          ← Back
        </button>
      ) : null}
      <h1 className="text-2xl font-semibold tracking-tight text-kiosk-text sm:text-3xl">{title}</h1>
    </div>
  );
}
