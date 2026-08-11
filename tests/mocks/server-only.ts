// Test-only stand-in for the "server-only" package (aliased in vitest.config.mts).
// The real package throws when imported outside a Server Component, which
// Vitest always is; this file intentionally exports nothing and has no
// side effects so app modules that `import "server-only"` can load under
// Vitest without weakening the real production guard.
