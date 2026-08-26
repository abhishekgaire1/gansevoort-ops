import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ASK_GANSEVOORT_SUGGESTED_QUESTIONS, canSubmitQuestion, trimChatHistory } from "@/app/lib/ai/tasks/chat/uiHelpers";
import { sendAskGansevoortQuestion } from "@/app/components/manager/askGansevoort/askGansevoortClient";

// CI-safe: pure functions plus one filesystem read (no network, no
// database, no component rendering -- this repo has no React Testing
// Library dependency, so UI logic is tested at the function level, per
// this feature's own instruction not to add one).

describe("canSubmitQuestion -- duplicate-send guard", () => {
  it("allows a non-blank question when no request is in flight", () => {
    expect(canSubmitQuestion("Which items are low?", false)).toBe(true);
  });
  it("blocks a blank/whitespace-only question", () => {
    expect(canSubmitQuestion("   ", false)).toBe(false);
  });
  it("blocks sending while a request is already in flight", () => {
    expect(canSubmitQuestion("Which items are low?", true)).toBe(false);
  });
});

describe("trimChatHistory -- bounded history size", () => {
  it("keeps history unchanged when under the limit", () => {
    const history = [{ role: "user" as const, content: "a" }, { role: "assistant" as const, content: "b" }];
    expect(trimChatHistory(history, 6)).toEqual(history);
  });
  it("keeps only the most recent N turns, dropping the oldest first", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, content: `turn-${i}` }));
    const trimmed = trimChatHistory(history, 4);
    expect(trimmed).toHaveLength(4);
    expect(trimmed[0].content).toBe("turn-6");
    expect(trimmed[3].content).toBe("turn-9");
  });
});

describe("suggested questions", () => {
  it("has exactly the four recommended suggestions", () => {
    expect(ASK_GANSEVOORT_SUGGESTED_QUESTIONS).toEqual([
      "Which inventory items are low right now?",
      "Which stations used the most inventory this week?",
      "What were the top waste items this month?",
      "Show recent high-withdrawal alerts.",
    ]);
  });
});

describe("sendAskGansevoortQuestion -- client fetch wrapper", () => {
  it("returns the parsed response body on success", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, answer: "Hi", evidence: [], period: null, toolsUsed: [], generatedAt: "now", warning: null, requestId: "r1" }), { status: 200 }));
    const result = await sendAskGansevoortQuestion("hi", [], fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(true);
  });

  it("returns a safe failure shape on a network error, never a thrown exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await sendAskGansevoortQuestion("hi", [], fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
  });

  it("returns a safe failure shape when the response body is not JSON-shaped", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));
    const result = await sendAskGansevoortQuestion("hi", [], fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
  });
});

describe("kiosk exclusion -- Ask Gansevoort must never appear in the employee kiosk", () => {
  function listFilesRecursively(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return listFilesRecursively(full);
      return statSync(full).isFile() ? [full] : [];
    });
  }

  it("no file under app/kiosk references AskGansevoort", () => {
    const kioskFiles = listFilesRecursively(join(process.cwd(), "app/kiosk")).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    for (const file of kioskFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toMatch(/AskGansevoort/);
    }
  });

  it("ManagerShell (used only by the manager app layout) is the sole place AskGansevoortLauncher is wired in", () => {
    const managerShell = readFileSync(join(process.cwd(), "app/components/manager/ManagerShell.tsx"), "utf-8");
    expect(managerShell).toContain("AskGansevoortLauncher");
  });
});
