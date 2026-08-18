"use client";

/**
 * The header/line field controls shared between Step 1 (Review Invoice, the
 * preparer's editable draft) and FinalReviewView's Invoice section (the
 * second manager's correction-editing view) -- extracted so both surfaces
 * use the exact same "changed"/"submitted" diff-highlighting presentation
 * rather than two drifting copies.
 */

export function MismatchNote({
  label,
  declared,
  aiSuggested,
  current,
}: {
  label: string;
  declared: string | null;
  aiSuggested: string | null;
  current: string | null;
}) {
  const notes: string[] = [];
  if (declared && declared !== current) notes.push(`Originally selected: ${declared}`);
  if (aiSuggested && aiSuggested !== current && aiSuggested !== declared) notes.push(`Gemini suggested: ${aiSuggested}`);
  if (notes.length === 0) return null;
  return (
    <p className="mb-2 text-xs text-amber-400">
      {label} — {notes.join(" · ")}
    </p>
  );
}

function FieldShell({ label, changed, submitted, children }: { label: string; changed?: boolean; submitted?: string | null; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      <span className="flex items-center gap-1.5">
        {label}
        {changed ? <span className="rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">Changed</span> : null}
      </span>
      {changed && submitted !== null && submitted !== undefined ? <span className="text-[10px] text-zinc-500">Submitted: {submitted}</span> : null}
      {children}
    </label>
  );
}

export function TextField({
  label,
  value,
  disabled,
  changed,
  submitted,
  onChange,
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  changed?: boolean;
  submitted?: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <FieldShell label={label} changed={changed} submitted={submitted}>
      <input
        type="text"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50 disabled:opacity-60"
      />
    </FieldShell>
  );
}

export function DateField({
  label,
  value,
  disabled,
  changed,
  submitted,
  onChange,
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  changed?: boolean;
  submitted?: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <FieldShell label={label} changed={changed} submitted={submitted}>
      <input
        type="date"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50 disabled:opacity-60"
      />
    </FieldShell>
  );
}

export function NumberField({
  label,
  value,
  disabled,
  changed,
  submitted,
  onChange,
}: {
  label: string;
  value: number | null;
  disabled: boolean;
  changed?: boolean;
  submitted?: string | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <FieldShell label={label} changed={changed} submitted={submitted}>
      <input
        type="number"
        step="0.01"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50 disabled:opacity-60"
      />
    </FieldShell>
  );
}

export function SelectField({
  label,
  value,
  disabled,
  changed,
  submitted,
  onChange,
  options,
}: {
  label: string;
  value: string;
  disabled: boolean;
  changed?: boolean;
  submitted?: string | null;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <FieldShell label={label} changed={changed} submitted={submitted}>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50 disabled:opacity-60"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
