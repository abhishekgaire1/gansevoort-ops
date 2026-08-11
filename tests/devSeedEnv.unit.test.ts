import { afterEach, describe, expect, it, vi } from "vitest";
import { envOrGenerated } from "../scripts/lib/envOrGenerated";

// CI-safe: pure/local logic only, no network, no database.

const VAR = "__TEST_ENV_OR_GENERATED__";

afterEach(() => {
  delete process.env[VAR];
});

describe("envOrGenerated", () => {
  it("uses the env var's value and does not call generate() when it is set to a non-empty value", () => {
    process.env[VAR] = "123456";
    const generate = vi.fn(() => "GENERATED");

    expect(envOrGenerated(VAR, generate)).toEqual({ value: "123456", wasGenerated: false });
    expect(generate).not.toHaveBeenCalled();
  });

  it("falls back to generate() when the env var is unset", () => {
    delete process.env[VAR];
    const generate = vi.fn(() => "GENERATED");

    expect(envOrGenerated(VAR, generate)).toEqual({ value: "GENERATED", wasGenerated: true });
  });

  it("falls back to generate() when the env var is present but empty", () => {
    // Regression test for the dev-seed bug: `DEV_SEED_EMPLOYEE_1_PIN=`
    // left blank in .env.local is present-but-empty, not unset. The old
    // `process.env[name] ?? generate()` only falls back on null/undefined,
    // so it kept the empty string and handed it to hashPinForStorage as
    // the PIN, which forwarded it to argon2id as `password: ""` -- failing
    // deep inside hash-wasm with "Password must be specified" instead of
    // a clear, actionable dev-seed error.
    process.env[VAR] = "";
    const generate = vi.fn(() => "GENERATED");

    expect(envOrGenerated(VAR, generate)).toEqual({ value: "GENERATED", wasGenerated: true });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
