/**
 * App-defined SQLSTATEs for the Admin Foundation milestone's RPCs,
 * continuing the GA0xx sequence (see app/lib/inventory/errors.ts and
 * others) rather than inventing a new numbering scheme.
 */
export const ADMIN_SQLSTATE = {
  VALIDATION: "GA033",
  NOT_FOUND: "GA034",
  LAST_ADMIN_REQUIRED: "GA035",
  SELF_CHANGE_BLOCKED: "GA036",
  INVALID_DEFAULT_STATION: "GA037",
  DUPLICATE_PIN: "GA038",
  ROLE_REQUIRES_APPLICATION_ACCOUNT: "GA039",
  DUPLICATE_ACTIVE_STATION_NAME: "GA040",
  DUPLICATE_INACTIVE_STATION_NAME: "GA041",
  STATION_HAS_ACTIVE_DEFAULT_EMPLOYEES: "GA042",
  PIN_ALREADY_IN_USE: "GA043",
  PIN_CONFLICTS_ON_REACTIVATION: "GA044",
  EMPLOYEE_NOT_ELIGIBLE_FOR_PIN: "GA045",
  EMPLOYEE_NOT_ELIGIBLE_FOR_PROVISIONING: "GA046",
  INVALID_CATEGORY: "GA047",
  INVALID_BASE_UNIT: "GA048",
  BASE_UNIT_CHANGE_BLOCKED_HISTORY: "GA049",
  ITEM_HAS_POSITIVE_STOCK: "GA050",
  ITEM_NOT_FOUND: "GA051",
  /** Reused from the existing itemMaster domain (public.normalize_item_name,
   * 20260811100060) -- one Postgres errcode means one thing everywhere in
   * this schema, so the Admin Item Master's own exact-duplicate check
   * raises the SAME GA016, never a second code for the identical
   * condition. */
  DUPLICATE_ITEM_NAME: "GA016",
  /** Admin Master Data milestone (20260811100100). */
  DUPLICATE_VENDOR_NAME: "GA052",
  DUPLICATE_VENDOR_ALIAS: "GA053",
  VENDOR_NOT_FOUND: "GA054",
  INVENTORY_CATEGORY_HAS_ACTIVE_ITEMS: "GA055",
  SPEND_CATEGORY_HAS_ACTIVE_CHILDREN: "GA056",
  /** Kiosk station assignment enforcement (20260811100130):
   * manager_set_employee_station_assignments -- one or more requested
   * station ids are not active stations in the caller's organization. */
  INVALID_STATION_ASSIGNMENT: "GA074",
} as const;

/** One error shape for every Admin mutation -- `code` lets the action
 * layer branch (e.g. the reactivation prompt needs the existing inactive
 * station id, carried in `detail`); `message` is always safe,
 * human-readable text, never a raw Postgres/constraint error (Part 44). */
export class AdminActionError extends Error {
  code: string;
  detail?: string;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = "AdminActionError";
    this.code = code;
    this.detail = detail;
  }
}

export function mapAdminRpcError(error: { code?: string; message: string; details?: string | null }): AdminActionError {
  switch (error.code) {
    case ADMIN_SQLSTATE.VALIDATION:
      return new AdminActionError("VALIDATION", "Check the values and try again.");
    case ADMIN_SQLSTATE.NOT_FOUND:
      return new AdminActionError("NOT_FOUND", "That record could not be found.");
    case ADMIN_SQLSTATE.LAST_ADMIN_REQUIRED:
      return new AdminActionError("LAST_ADMIN_REQUIRED", "At least one active Admin is required.");
    case ADMIN_SQLSTATE.SELF_CHANGE_BLOCKED:
      return new AdminActionError("SELF_CHANGE_BLOCKED", error.message);
    case ADMIN_SQLSTATE.INVALID_DEFAULT_STATION:
      return new AdminActionError("INVALID_DEFAULT_STATION", "Choose an active station.");
    case ADMIN_SQLSTATE.DUPLICATE_PIN:
      return new AdminActionError("DUPLICATE_PIN", "That PIN is already in use. Choose a different one.");
    case ADMIN_SQLSTATE.ROLE_REQUIRES_APPLICATION_ACCOUNT:
      return new AdminActionError("ROLE_REQUIRES_APPLICATION_ACCOUNT", "This employee has no application login account. Manager/Admin access requires one.");
    case ADMIN_SQLSTATE.DUPLICATE_ACTIVE_STATION_NAME:
      return new AdminActionError("DUPLICATE_STATION_NAME", error.message);
    case ADMIN_SQLSTATE.DUPLICATE_INACTIVE_STATION_NAME:
      return new AdminActionError("DUPLICATE_INACTIVE_STATION_NAME", error.message, error.details ?? undefined);
    case ADMIN_SQLSTATE.STATION_HAS_ACTIVE_DEFAULT_EMPLOYEES:
      return new AdminActionError("STATION_HAS_DEPENDENTS", error.message, error.details ?? undefined);
    case ADMIN_SQLSTATE.PIN_ALREADY_IN_USE:
      return new AdminActionError("PIN_ALREADY_IN_USE", "That PIN is already in use. Choose a different PIN.");
    case ADMIN_SQLSTATE.PIN_CONFLICTS_ON_REACTIVATION:
      return new AdminActionError(
        "PIN_CONFLICTS_ON_REACTIVATION",
        "This user's existing kiosk PIN is now assigned to another active user. Reset the PIN before reactivating kiosk access."
      );
    case ADMIN_SQLSTATE.EMPLOYEE_NOT_ELIGIBLE_FOR_PIN:
      return new AdminActionError("EMPLOYEE_NOT_ELIGIBLE_FOR_PIN", "Reactivate this employee before setting a kiosk PIN.");
    case ADMIN_SQLSTATE.EMPLOYEE_NOT_ELIGIBLE_FOR_PROVISIONING:
      return new AdminActionError("EMPLOYEE_NOT_ELIGIBLE_FOR_PROVISIONING", "Reactivate this employee before granting application access.");
    case ADMIN_SQLSTATE.INVALID_CATEGORY:
      return new AdminActionError("INVALID_CATEGORY", "Choose an active inventory category.");
    case ADMIN_SQLSTATE.INVALID_BASE_UNIT:
      return new AdminActionError("INVALID_BASE_UNIT", "Choose a valid unit.");
    case ADMIN_SQLSTATE.BASE_UNIT_CHANGE_BLOCKED_HISTORY:
      return new AdminActionError("BASE_UNIT_CHANGE_BLOCKED_HISTORY", "Base unit cannot be changed because this item already has inventory history.");
    case ADMIN_SQLSTATE.ITEM_HAS_POSITIVE_STOCK:
      return new AdminActionError("ITEM_HAS_POSITIVE_STOCK", "This item cannot be deactivated while inventory remains in stock. Resolve current inventory first.");
    case ADMIN_SQLSTATE.ITEM_NOT_FOUND:
      return new AdminActionError("ITEM_NOT_FOUND", "That item could not be found.");
    case ADMIN_SQLSTATE.DUPLICATE_ITEM_NAME:
      return new AdminActionError("DUPLICATE_ITEM_NAME", error.message, error.details ?? undefined);
    case ADMIN_SQLSTATE.DUPLICATE_VENDOR_NAME:
      return new AdminActionError("DUPLICATE_VENDOR_NAME", error.message, error.details ?? undefined);
    case ADMIN_SQLSTATE.DUPLICATE_VENDOR_ALIAS:
      return new AdminActionError("DUPLICATE_VENDOR_ALIAS", "That alias is already in use by a vendor.");
    case ADMIN_SQLSTATE.VENDOR_NOT_FOUND:
      return new AdminActionError("VENDOR_NOT_FOUND", "That vendor could not be found.");
    case ADMIN_SQLSTATE.INVENTORY_CATEGORY_HAS_ACTIVE_ITEMS:
      return new AdminActionError("CATEGORY_HAS_DEPENDENTS", error.message, error.details ?? undefined);
    case ADMIN_SQLSTATE.SPEND_CATEGORY_HAS_ACTIVE_CHILDREN:
      return new AdminActionError("CATEGORY_HAS_DEPENDENTS", error.message, error.details ?? undefined);
    case ADMIN_SQLSTATE.INVALID_STATION_ASSIGNMENT:
      return new AdminActionError("INVALID_STATION_ASSIGNMENT", "One or more selected stations are not active. Refresh and try again.");
    default:
      return new AdminActionError("UNKNOWN", "Unable to save. Try again.");
  }
}
