/** Resolves an optional env var, treating a present-but-empty value (e.g.
 * `DEV_SEED_EMPLOYEE_1_PIN=` left blank in .env.local) the same as an
 * absent one. `process.env[name] ?? generate()` is NOT equivalent: `??`
 * only falls back on null/undefined, so a blank env var would pass an
 * empty string straight through to hashPinForStorage/Supabase Auth. */
export function envOrGenerated(name: string, generate: () => string): { value: string; wasGenerated: boolean } {
  const raw = process.env[name];
  if (raw) return { value: raw, wasGenerated: false };
  return { value: generate(), wasGenerated: true };
}
