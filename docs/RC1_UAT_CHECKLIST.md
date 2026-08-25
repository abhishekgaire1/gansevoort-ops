# RC1 Manager / iPad UAT Checklist

This checklist covers the staging (DEV-backed) deployment only. It is not a
production sign-off document until every scenario below is recorded and the
owner has signed off.

**Environment:** staging preview, backed by the DEV Supabase project only.
Use synthetic test data only. Do not enter real inventory, real invoices,
real employee PINs, or real payroll/financial data anywhere in this
environment.

---

## A. Test information

Fill in manually before starting:

| Field | Value |
|---|---|
| Tester | |
| Date | |
| Staging URL | |
| iPad model | |
| iPadOS version | |
| Browser | |
| Manager test account | |
| Employee test account | |
| Test station | |
| Result (Pass/Fail) | |
| Notes / issue reference | |

Do not write passwords or PINs into this document, in any field, at any time.

---

## B. Pre-test requirements

Confirm before testing begins:

- [ ] The page visibly belongs to the staging/DEV environment (URL, or an
      environment banner if the application already shows one).
- [ ] Only synthetic test data will be used for the remainder of this
      checklist.
- [ ] The test manager account can access the DEV organization.
- [ ] A synthetic employee and station already exist (created through the
      existing admin interface — see Section G of the final report for what
      to create if missing).
- [ ] Test inventory exists in a test storage location.
- [ ] No real operational record will be entered during this pass.

---

## C. Manager authentication

1. Valid manager login succeeds.
2. Invalid login (wrong password) is rejected with a safe, generic message.
3. A non-manager/employee account cannot reach a manager-only route directly
   by URL.
4. Session refresh: staying on a manager page for an extended period does
   not force an unexpected logout.
5. Session expiry: an expired session redirects to login rather than
   showing a broken page.
6. Logout works and returns to the login page.
7. After logout, using the browser's back button does not reveal any
   previously-loaded manager page content.

---

## D. Employee / iPad authentication

1. Correct six-digit PIN succeeds.
2. Incorrect PIN is rejected with a safe, generic message.
3. Repeated incorrect PIN attempts trigger rate-limit behavior rather than
   unlimited retries.
4. PIN entry touch targets are comfortably usable on the actual iPad.
5. Session expiry is handled safely (no stuck/broken state).
6. Reauthentication (re-entering a PIN) works cleanly after expiry.
7. Refreshing/reloading the kiosk page behaves safely (no broken or
   half-authenticated state).
8. The entered PIN is never visibly displayed on screen after entry.

---

## E. Station authorization

1. An employee locked to a default station sees only that station.
2. An employee configured to choose a station sees the correct allowed
   choices.
3. A station the employee is not authorized for cannot be used, even if
   attempted directly.
4. Station selection persists only as intended (does not leak into the
   next employee's session).
5. Switching to a different employee clears the previous employee's station
   context.

---

## F. Single withdrawal

1. Choose an item.
2. Choose the correct source (storage) location.
3. Choose a unit.
4. Enter a quantity.
5. The confirmation step shows the quantity/unit before final submission.
6. Submit.
7. A clear success state appears.
8. The inventory balance decreases exactly once.
9. Recently-used items behave as expected (e.g. appear in a recent-items
   list, if present).
10. Tapping submit twice quickly does not create a duplicate movement.
11. Requesting more than what's available produces a safe, understandable
    message (not a raw error).
12. An inactive item/unit is unavailable in the picker or is safely
    rejected if somehow selected.
13. Simulated poor network / an interrupted request does not leave the
    kiosk in a broken or ambiguous state.

---

## G. Batch withdrawal

1. Add several items to the cart.
2. Edit a quantity.
3. Remove a line.
4. Submit the batch.
5. The entire batch succeeds together.
6. One invalid or insufficient line prevents the whole batch from partially
   posting (all-or-nothing).
7. Submitting the same batch twice quickly does not create a second batch.
8. Inventory balances change exactly once per item/location touched by the
   batch.

---

## H. High-withdrawal alert

Using synthetic test rules/data (a test item with a known configured
threshold):

1. A withdrawal below the threshold creates no alert.
2. A withdrawal exactly at the threshold creates no alert.
3. A withdrawal above the threshold still completes normally (never
   blocked, never delayed).
4. A withdrawal above the threshold creates an entry under Inventory
   Alerts.
5. The manager notification bell shows the new notification.
6. Clicking the notification opens the correct alert detail page.
7. The Inventory Alerts navigation entry opens the alerts list.
8. The newest alert appears first in the list.
9. Item, station, employee, quantity, unit, and the threshold recorded at
   the time of the alert are all correct.
10. The detail page states the withdrawal was completed and the alert is
    informational.
11. No Approve/Reject/Acknowledge/Resolve action appears anywhere on the
    list or detail page.
12. An alert belonging to a different organization cannot be opened (not
    found / rejected, never shown).
13. Repeating the same over-threshold submission (idempotent retry) does
    not create a second alert or a second notification.

---

## I. Receiving and inventory posting

1. Create/upload a synthetic purchase document.
2. Record a partial receiving against it.
3. Record an additional delivery against the same document.
4. The employee who uploaded the document cannot also verify it.
5. A different authorized manager can verify it.
6. Inventory posting happens as its own, separate, controlled step (not
   automatically bundled into receiving).
7. Attempting to post the same document twice does not double-post
   inventory.
8. The inventory balance increases correctly after posting.
9. The original receipt history remains visible and unchanged.
10. A correction is additive (a new event), not a silent rewrite of the
    original receipt.

---

## J. Cycle counts

1. Start a cycle count.
2. Confirm it is scoped to the correct location.
3. A blank quantity field remains blank (not silently treated as zero).
4. A physical count of zero is accepted as a real, intentional zero.
5. A zero difference completes with no inventory movement created.
6. A positive difference creates an inbound adjustment.
7. A negative difference creates an outbound adjustment.
8. A count with both increases and decreases across different items
   creates the appropriate grouped inbound/outbound adjustment(s).
9. Completion requires the completion note already established in this
   product (cannot complete with it blank).
10. Submitting completion twice does not create a second adjustment.
11. If inventory changes concurrently with counting, the count safely
    detects this rather than silently posting a wrong adjustment.
12. A completion notification appears for other managers/admins.
13. No second-manager approval step appears anywhere in this flow — a
    single authorized manager can start and complete a count alone.

---

## K. Storage waste

1. Open Inventory Waste.
2. Select a storage location.
3. Select an item/unit.
4. Enter a valid quantity.
5. Select a reason.
6. Selecting `Other` requires a note before submission.
7. Submit.
8. The storage balance decreases exactly once.
9. Waste history/detail is visible afterward.
10. A manager notification appears for the waste event.
11. Submitting the same waste request twice does not create duplicate
    waste records.
12. Requesting more than what's available is safely rejected.
13. Recording storage waste never creates a High-Withdrawal alert.

---

## L. Reports and downloads

Repeat for each of: **Overview, Purchasing, Usage, Waste, Receiving,
Inventory Status.**

1. The page loads.
2. The displayed date range matches what was selected.
3. Filters (vendor/category/location, where applicable) work correctly.
4. Excel download works.
5. CSV download works.
6. PDF download works.
7. The downloaded filename is correct and predictable.
8. Every downloaded file opens without corruption.
9. Numeric values remain real numeric cells in Excel (not text).
10. A report with no data still downloads successfully (not an error).
11. Where applicable, the PDF shows a "showing top N — download Excel for
    full detail" notice rather than silently truncating.
12. No other organization's data appears anywhere in any export.

---

## M. Notification bell

1. Unread count displays correctly.
2. Opening/marking a notification as read behaves correctly.
3. A cycle-count-completion notification routes to the correct cycle count.
4. A waste notification routes to the correct waste event.
5. A high-withdrawal notification routes to the correct alert.
6. A notification pointing at a since-deleted or otherwise missing entity
   fails safely (no crash, no broken page).
7. No notification belonging to another organization ever appears.

---

## N. iPad usability

Test in both portrait and landscape:

1. No horizontal clipping/scrolling of page content.
2. Buttons are comfortably tappable (no accidental mis-taps).
3. The on-screen keyboard never covers the field or button currently in
   use.
4. Scroll position behaves sensibly after actions (no unexpected jumps).
5. Confirmation screens are legible at a normal viewing distance.
6. Loading states are clearly visible (no ambiguous blank screens).
7. Errors provide a clear way to recover (retry / go back).
8. Double-tapping a submit button never causes a double submission.
9. A deliberately slow network still leaves the app understandable (not
   stuck with no feedback).
10. Backgrounding Safari (e.g. switching apps) and reopening it recovers
    correctly, without a broken session.

---

## O. Final outcome

- [ ] Every scenario above is marked **Pass**, **Fail**, or **Not
      Applicable**.
- [ ] A screenshot is attached for every **Fail**.
- [ ] The exact route and timestamp is recorded for every **Fail**.
- [ ] No production promotion occurs while any P0 or P1 failure remains
      open.
- [ ] Final sign-off recorded below.

**Owner sign-off:** ____________________  **Date:** ____________
