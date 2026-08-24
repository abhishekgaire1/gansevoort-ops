import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  startOrResumeCycleCount,
  addCycleCountLine,
  recordCycleCountLineObservation,
  completeCycleCount,
  cancelCycleCount,
  getCycleCountDetail,
  listCycleCountDraftStatusForOrganization,
} from "@/app/lib/inventory/cycleCounts";
import { CycleCountOwnedByAnotherManagerError } from "@/app/lib/inventory/errors";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment for the shared rationale.
 *
 * Cycle Count DRAFT ownership (20260811100082_cycle_count_draft_
 * ownership.sql) -- only inventory_cycle_counts.started_by_app_user_id may
 * resume/mutate a DRAFT. "Manager A" and "Manager B" below are two
 * distinct, real, ACTIVE app_users in the SAME canonical fixture org
 * (fx.changeableEmployeeAppUserId / fx.lockedEmployeeAppUserId) -- the
 * ownership check is keyed purely on app_user id, never on a "manager" vs
 * "employee" role distinction (that gate lives at the Server Action layer,
 * requireManagerOrAdmin, not in the RPCs), so this is a faithful test of
 * the actual enforcement boundary. Every test creates its own fresh
 * location, for the same cross-talk-avoidance reason as cycleCounts.rpc.
 * test.ts.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;
const MANAGER_A = () => fx.changeableEmployeeAppUserId;
const MANAGER_B = () => fx.lockedEmployeeAppUserId;

async function createStorageLocation(organizationId: string): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { data, error } = await fx.supabase
    .from("locations")
    .insert({ organization_id: organizationId, name: `TEST Ownership Location ${tag}`, timezone: "America/New_York", is_storage_eligible: true })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
}, 60_000);

describe("cycle count DRAFT ownership", () => {
  it("1. the starter can resume their own DRAFT", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const started = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });
    expect(started.resumed).toBe(false);

    const resumed = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });
    expect(resumed.resumed).toBe(true);
    expect(resumed.cycleCountId).toBe(started.cycleCountId);
  });

  it("2. another manager cannot resume it -- no second DRAFT is created", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const started = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });

    await expect(startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_B() })).rejects.toThrow(
      CycleCountOwnedByAnotherManagerError
    );

    const { count } = await fx.supabase
      .from("inventory_cycle_counts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId)
      .eq("location_id", locationId)
      .eq("status", "DRAFT");
    expect(count).toBe(1);
    const { data: cc } = await fx.supabase.from("inventory_cycle_counts").select("started_by_app_user_id").eq("id", started.cycleCountId).single();
    expect(cc!.started_by_app_user_id).toBe(MANAGER_A());
  });

  it("3. another manager cannot add a line", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const started = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });

    await expect(
      addCycleCountLine(fx.supabase, { cycleCountId: started.cycleCountId, inventoryItemId: fx.noRuleItemId, actorAppUserId: MANAGER_B() })
    ).rejects.toThrow(CycleCountOwnedByAnotherManagerError);
  });

  it("4. another manager cannot record an observation", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const started = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });
    await addCycleCountLine(fx.supabase, { cycleCountId: started.cycleCountId, inventoryItemId: fx.noRuleItemId, actorAppUserId: MANAGER_A() });

    await expect(
      recordCycleCountLineObservation(fx.supabase, {
        cycleCountId: started.cycleCountId,
        inventoryItemId: fx.noRuleItemId,
        physicalCountQuantity: "5",
        actorAppUserId: MANAGER_B(),
      })
    ).rejects.toThrow(CycleCountOwnedByAnotherManagerError);
  });

  it("5. another manager cannot refresh a stale snapshot (recount) either", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const started = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });
    await addCycleCountLine(fx.supabase, { cycleCountId: started.cycleCountId, inventoryItemId: fx.noRuleItemId, actorAppUserId: MANAGER_A() });

    await expect(
      recordCycleCountLineObservation(fx.supabase, {
        cycleCountId: started.cycleCountId,
        inventoryItemId: fx.noRuleItemId,
        physicalCountQuantity: "5",
        actorAppUserId: MANAGER_B(),
        refreshSnapshot: true,
      })
    ).rejects.toThrow(CycleCountOwnedByAnotherManagerError);
  });

  it("6. another manager cannot complete it", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const started = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });
    await addCycleCountLine(fx.supabase, { cycleCountId: started.cycleCountId, inventoryItemId: fx.noRuleItemId, actorAppUserId: MANAGER_A() });
    await recordCycleCountLineObservation(fx.supabase, {
      cycleCountId: started.cycleCountId,
      inventoryItemId: fx.noRuleItemId,
      physicalCountQuantity: "5",
      actorAppUserId: MANAGER_A(),
    });

    await expect(
      completeCycleCount(fx.supabase, { cycleCountId: started.cycleCountId, expectedVersion: started.version, completedByAppUserId: MANAGER_B(), completionNote: "Test completion note." })
    ).rejects.toThrow(CycleCountOwnedByAnotherManagerError);

    const { count: movementCount } = await fx.supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .eq("cycle_count_id", started.cycleCountId);
    expect(movementCount).toBe(0);
    const { data: cc } = await fx.supabase.from("inventory_cycle_counts").select("status").eq("id", started.cycleCountId).single();
    expect(cc!.status).toBe("DRAFT");
  });

  it("7. another manager cannot cancel it", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const started = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });

    await expect(
      cancelCycleCount(fx.supabase, { cycleCountId: started.cycleCountId, expectedVersion: started.version, cancelledByAppUserId: MANAGER_B(), reason: "trying to take over" })
    ).rejects.toThrow(CycleCountOwnedByAnotherManagerError);

    const { data: cc } = await fx.supabase.from("inventory_cycle_counts").select("status").eq("id", started.cycleCountId).single();
    expect(cc!.status).toBe("DRAFT");
  });

  it("8. direct access (getCycleCountDetail) never exposes the draft as editable to a non-owner", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const started = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });

    const asOwner = await getCycleCountDetail(fx.supabase, fx.organizationId, started.cycleCountId, MANAGER_A());
    expect(asOwner?.isOwnedByCurrentManager).toBe(true);

    const asOther = await getCycleCountDetail(fx.supabase, fx.organizationId, started.cycleCountId, MANAGER_B());
    expect(asOther?.isOwnedByCurrentManager).toBe(false);
    // The safe fields are still readable (name/status), matching Part
    // "DIRECT URL PROTECTION"'s "Cycle count in progress, started by X"
    // message -- but isOwnedByCurrentManager is the ONLY signal the UI is
    // allowed to gate editable rendering on, and it correctly reads false.
    expect(asOther?.startedByAppUserId).toBe(MANAGER_A());
  });

  it("9. calling start again as the SAME manager resumes the existing draft", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const first = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });
    const second = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });
    expect(second.cycleCountId).toBe(first.cycleCountId);
    expect(second.resumed).toBe(true);
  });

  it("10. calling start as a DIFFERENT manager never creates a second draft", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const first = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });
    await expect(startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_B() })).rejects.toThrow(
      CycleCountOwnedByAnotherManagerError
    );

    const { data: allDrafts } = await fx.supabase
      .from("inventory_cycle_counts")
      .select("id")
      .eq("organization_id", fx.organizationId)
      .eq("location_id", locationId);
    expect(allDrafts).toHaveLength(1);
    expect(allDrafts![0].id).toBe(first.cycleCountId);
  });

  it("11. concurrent two-manager start produces exactly one owner (race condition)", async () => {
    const locationId = await createStorageLocation(fx.organizationId);

    // Index 0 is always Manager A's call, index 1 always Manager B's --
    // Promise.allSettled preserves input order, so this tells us exactly
    // which manager won without guessing.
    const [resultA, resultB] = await Promise.allSettled([
      startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() }),
      startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_B() }),
    ]);

    // Exactly one of the two calls succeeds (as the owner); the other is
    // rejected with the ownership error -- never two successes, never two
    // silent failures.
    const outcomes = [resultA.status, resultB.status];
    expect(outcomes.filter((s) => s === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((s) => s === "rejected")).toHaveLength(1);

    const winner =
      resultA.status === "fulfilled"
        ? { manager: MANAGER_A(), result: resultA.value }
        : { manager: MANAGER_B(), result: (resultB as PromiseFulfilledResult<Awaited<ReturnType<typeof startOrResumeCycleCount>>>).value };
    const loser = resultA.status === "rejected" ? resultA : (resultB as PromiseRejectedResult);
    expect(loser.reason).toBeInstanceOf(CycleCountOwnedByAnotherManagerError);

    const { data: allDrafts } = await fx.supabase
      .from("inventory_cycle_counts")
      .select("id, started_by_app_user_id")
      .eq("organization_id", fx.organizationId)
      .eq("location_id", locationId);
    expect(allDrafts).toHaveLength(1); // exactly one DRAFT, no matter who won
    expect(allDrafts![0].started_by_app_user_id).toBe(winner.manager);
    expect(winner.result.cycleCountId).toBe(allDrafts![0].id);
  });

  it("12. org isolation still holds -- a location in a different organization is rejected regardless of ownership", async () => {
    const otherOrgLocationId = await createStorageLocation(otherOrg.organizationId);
    await expect(
      startOrResumeCycleCount(fx.supabase, { locationId: otherOrgLocationId, startedByAppUserId: MANAGER_A() })
    ).rejects.toThrow(/not an active, storage-eligible location/);

    // getCycleCountDetail scoped to fx.organizationId must never resolve a
    // count that (hypothetically) belonged to another org.
    const otherOrgStarted = await startOrResumeCycleCount(fx.supabase, { locationId: otherOrgLocationId, startedByAppUserId: otherOrg.appUserId });
    const crossOrgLookup = await getCycleCountDetail(fx.supabase, fx.organizationId, otherOrgStarted.cycleCountId, MANAGER_A());
    expect(crossOrgLookup).toBeNull();
  });

  it("13. the draft-status listing exposes started-by name/time safely", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });

    const asOwner = await listCycleCountDraftStatusForOrganization(fx.supabase, fx.organizationId, MANAGER_A());
    const ownRow = asOwner.find((d) => d.locationId === locationId);
    expect(ownRow).toBeDefined();
    expect(ownRow!.isOwnedByCurrentManager).toBe(true);
    expect(ownRow!.canResume).toBe(true);
    expect(ownRow!.startedByName.length).toBeGreaterThan(0);
    expect(typeof ownRow!.startedAt).toBe("string");

    const asOther = await listCycleCountDraftStatusForOrganization(fx.supabase, fx.organizationId, MANAGER_B());
    const otherRow = asOther.find((d) => d.locationId === locationId);
    expect(otherRow).toBeDefined();
    expect(otherRow!.isOwnedByCurrentManager).toBe(false);
  });

  it("14. canResume is true only for the owner", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });

    const [asOwner, asOther] = await Promise.all([
      listCycleCountDraftStatusForOrganization(fx.supabase, fx.organizationId, MANAGER_A()),
      listCycleCountDraftStatusForOrganization(fx.supabase, fx.organizationId, MANAGER_B()),
    ]);
    expect(asOwner.find((d) => d.locationId === locationId)!.canResume).toBe(true);
    expect(asOther.find((d) => d.locationId === locationId)!.canResume).toBe(false);
  });

  it("15. completed/cancelled records remain immutable regardless of who asks -- but a non-owner can still safely replay a COMPLETED read", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const started = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });
    await addCycleCountLine(fx.supabase, { cycleCountId: started.cycleCountId, inventoryItemId: fx.noRuleItemId, actorAppUserId: MANAGER_A() });
    await recordCycleCountLineObservation(fx.supabase, {
      cycleCountId: started.cycleCountId,
      inventoryItemId: fx.noRuleItemId,
      physicalCountQuantity: "3",
      actorAppUserId: MANAGER_A(),
    });
    await completeCycleCount(fx.supabase, { cycleCountId: started.cycleCountId, expectedVersion: started.version, completedByAppUserId: MANAGER_A(), completionNote: "Test completion note." });

    // A non-owner "completing" an already-COMPLETED count is a harmless
    // replay read (Part "COMPLETION / CANCELLATION" pairs with the
    // migration's own "deliberately NOT gated on ownership" comment for
    // this specific terminal-replay case) -- it must NOT raise ownership,
    // and it must NOT create a second adjustment.
    const replay = await completeCycleCount(fx.supabase, { cycleCountId: started.cycleCountId, expectedVersion: started.version, completedByAppUserId: MANAGER_B(), completionNote: "Test completion note." });
    expect(replay.replayed).toBe(true);

    // But no one -- owner or not -- can further mutate it.
    await expect(
      recordCycleCountLineObservation(fx.supabase, { cycleCountId: started.cycleCountId, inventoryItemId: fx.noRuleItemId, physicalCountQuantity: "99", actorAppUserId: MANAGER_A() })
    ).rejects.toThrow(/not open for counting/);

    const { count: inCount } = await fx.supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .eq("cycle_count_id", started.cycleCountId)
      .eq("movement_type", "COUNT_ADJUSTMENT_IN");
    expect(inCount).toBe(1); // exactly one, never doubled by the non-owner replay
  });
});
