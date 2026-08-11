import { config } from "dotenv";

// Loads .env.local for tests that need it (the manual integration/RPC
// tests). pin.unit.test.ts needs no env vars at all and is unaffected if
// .env.local doesn't exist.
config({ path: ".env.local" });
