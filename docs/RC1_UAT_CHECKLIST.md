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

## O. Ask Gansevoort

Manager/admin-only, read-only AI chat. Uses synthetic DEV data only. None
of the scenarios below are pre-marked as passed -- record Pass/Fail/Not
Applicable for each during the real manual pass.

1. The "Ask Gansevoort" floating button appears for a signed-in manager/admin.
2. The button and chat interface do NOT appear anywhere in the employee kiosk (PIN entry, station selection, withdrawal screens).
3. The drawer opens on click and closes via the close button, the backdrop, and the Escape key, each restoring focus to the trigger button.
4. Desktop: the drawer opens as a right-side panel (~420-480px wide) without covering the entire screen or blocking the rest of the page from being reachable once closed.
5. iPad portrait: the panel is full/near-full-screen, no horizontal scrolling or clipped content.
6. iPad landscape: same, with the input and send button still reachable without the keyboard hiding them.
7. Typing, Enter-to-send, Shift+Enter for a new line, and the on-screen keyboard all behave correctly; sending is disabled while a request is in flight and while the question is blank.
8. The four suggested questions appear on first open and each one submits correctly when tapped.
9. Inventory question (e.g. "Which inventory items are low right now?") returns a plausible answer with Inventory Status evidence.
10. Purchasing question (e.g. "Which vendor had the most purchases?") returns an answer with Purchasing Report evidence.
11. Receiving question (e.g. "What is received but not posted?") returns an answer with Receiving Report evidence.
12. Usage question (e.g. "Which station used the most inventory this week?") returns an answer with Usage Report evidence.
13. Waste question (e.g. "What were the top waste items this month?") returns an answer with Waste Report evidence, and never mentions station waste as tracked.
14. Cycle-count question (e.g. "Which counts were completed recently?") returns an answer with a link to the correct cycle count detail page, and never mentions second-manager approval.
15. Inventory Alert question (e.g. "Show recent high-withdrawal alerts.") returns an answer describing alerts as informational only, with a link to the correct alert detail page, and no Approve/Reject/Acknowledge action anywhere.
16. Every evidence card link opens the correct manager page/record when clicked.
17. The date range or "as of" time shown matches the organization's own timezone and the question asked (e.g. "this week" resolves to the correct 7-day window).
18. A question with genuinely no matching data returns "I don't have enough verified data to answer that confidently" rather than a guess.
19. An out-of-scope or nonsensical question is handled safely (no crash, no fabricated answer).
20. Asking Ask Gansevoort to perform an action (e.g. "record a withdrawal of 10 lb of chicken") returns exactly: "Ask Gansevoort can explain your operational data, but it cannot make changes." -- and no inventory/withdrawal/waste/cycle-count record is created.
21. If the AI provider is unavailable or times out, the chat shows a safe, generic message ("Ask Gansevoort is temporarily unavailable. Try again shortly." or similar) -- never a raw error or stack trace.
22. Asking more questions than the rate limit allows in a short window shows a safe "You've reached the question limit..." message, not a crash.
23. Disconnecting/interrupting the network mid-request is handled safely (no stuck spinner forever, a way to retry).
24. If the manager's session expires mid-conversation, the chat shows a safe "session expired" state rather than a broken request.
25. "New conversation" clears the visible history; refreshing or closing the page also clears it (no persisted chat history anywhere).
26. No response ever shows a raw provider/database error message, stack trace, or internal id in the answer text.
27. No answer or evidence card ever shows another organization's data.
28. Answers include the "AI can make mistakes. Verify important decisions using the cited records." footer, and any answer with incomplete data shows its warning text.

### Item purchase cost and multi-turn follow-ups

None of the scenarios below are pre-marked as passed -- record Pass/Fail/Not Applicable for each during the real manual pass, using a synthetic test item with known, verified purchase history.

29. Direct item-cost question (e.g. "How much did Whole Milk Quart cost us?") returns the latest verified purchase price, its vendor and document date, and the normalized price per base unit -- not an organization-wide purchasing total.
30. Follow-up using "it" (ask about an item's inventory, then ask "How much did it cost us?" in the next message) correctly answers about the SAME item's cost, not a repeated inventory quantity and not an aggregate total.
31. Item clarification on the next turn (ask "How much did it cost us?" with no item yet named, then reply with just the item's name on the following turn) resolves to that item's verified cost, not a fresh unrelated answer.
32. "What about the average price?" after a cost answer returns the recent weighted-average price for the SAME item, correctly weighted by quantity (not a plain average of individual purchase prices).
33. Package-to-base-unit conversion is shown correctly (e.g. a per-case verified price and its correctly normalized per-piece/per-unit price for the same purchase).
34. Current-stock estimate (e.g. "How much are all 406 worth?") combines the current quantity with the latest verified purchase price, and explicitly states "This is an operational estimate, not an accounting inventory valuation."
35. An item that exists in inventory but has no verified/posted purchase cost gets a clear, explicit answer to that effect -- never a fallback to an unrelated organization-wide total, and never a guessed cost.
36. An ambiguous item name (matching more than one inventory item) makes the assistant ask which item is meant, listing the candidates, rather than silently picking one.
37. A cost question about an item that does not exist at all is handled safely (no crash, no invented cost).
38. Cross-organization purchase/vendor data is never shown in a cost answer or its evidence.
39. Evidence links for a cost answer point to the item's own detail page and/or the vendor-filtered Purchasing Report -- both real, working links.
40. Refreshing the page or starting "New conversation" clears the pending item-cost context along with the rest of the conversation (no stale item carried over from a previous browser tab session).
41. No inventory, purchasing, receiving, or any other record is created, changed, or posted at any point during item-cost questions -- read-only throughout.
42. A synthetic item with a PARTIALLY posted purchase line (e.g. 5 of 10 cases posted so far) does not show an inflated interim unit cost -- either that purchase is silently excluded, or the item correctly reports no verified cost, never the too-high partial figure.
43. Evidence for a cost answer links to the actual verified purchase document (showing vendor, date, line items and price), not only the item's own detail page.
44. If a weighted average genuinely cannot be confirmed complete for the requested window, the assistant says so plainly rather than presenting a partial sample as "the" weighted average.

### General Report Builder (natural-language downloadable Excel reports)

None of the scenarios below are pre-marked as passed -- record Pass/Fail/Not Applicable for each during the real manual pass, using synthetic operational data and synthetic verified purchase history. The Waste Cost Report scenarios from an earlier milestone are superseded by this section -- Waste is now one of nine registered reports here, not a separate architecture.

45. Purchasing export: "Export purchases from [vendor] this month by item" produces a real .xlsx with vendor/category/item totals and, if requested, recent price changes.
46. Receiving export: "Create a receiving report grouped by vendor" produces a real .xlsx with document counts and posting status by vendor/status -- never a fabricated dollar figure (this dataset carries none).
47. Inventory-status export: "Give me a current low-stock inventory report" produces a real .xlsx of currently low/out-of-stock items -- clearly a point-in-time snapshot, never a historical reconstruction.
48. Usage export: "Give me an Excel report of withdrawals by station for last week" produces a real .xlsx with item/station withdrawal totals for that exact week.
49. Waste export: "Create a report of all waste from the last 10 days and include pricing" produces a real .xlsx with waste event detail, By Item, and By Reason sheets, priced/unpriced counts, and the required estimated-cost disclaimer.
50. Cycle-count export: "Create a cycle-count variance report for August" produces a real .xlsx of that month's cycle-count sessions with counted/variance item counts -- never a resurrected second-manager-approval or 20%-threshold concept.
51. Inventory-alert export: "Download all open inventory alerts" produces a real .xlsx of High-Withdrawal Alerts -- clearly informational, never framed as pending approval.
52. Reports-overview export: a general overview export produces the same fixed whole-organization metrics as the on-screen Overview page, nothing invented.
53. Item-cost-history export: "Export the price history for Whole Milk Quart" requires and uses a single resolved item, and lists its verified purchase lines newest first with normalized per-base-unit cost.
54. Relative dates: "last 10 days," "yesterday," "this week," "last week," "this month," and "last month" each resolve to the exact correct calendar range in the organization's own timezone.
55. Custom/named dates: an explicit date range and a named month (e.g. "August 2026") both resolve correctly, including a leap-day February and a December-to-January rollover.
56. A vendor, item, station, and location filter each correctly narrow a report to just that record when the manager names one that exists.
57. A grouping request (e.g. "grouped by vendor") selects the correct sheet/breakdown; an unsupported grouping falls back to the report's default and the assistant says so.
58. A specific column selection is honored where supported; an unsupported column request is dropped with an honest explanation, never silently invented.
59. Pricing supported: a dataset with `includePricing` produces real priced figures with the correct "actual" vs "estimated" framing and, for estimated pricing, the required disclaimer sentence.
60. Pricing unsupported: asking for pricing on Receiving or Cycle Counts is refused for pricing specifically (the report itself still generates) with a plain explanation that this dataset has no dollar amounts.
61. Unpriced records: at least one dataset's export shows some records priced and others explicitly marked unpriced, with a truthful priced/unpriced count and a total that only ever sums the priced records.
62. Empty reports: requesting any dataset for a period/filter with zero matching records still downloads a valid workbook with headers, metadata, and a clear "no records" message.
63. Ambiguous filters: naming a vendor/item/station/location that matches more than one real record makes the assistant list the candidates and ask which one, rather than guessing.
64. Excel download on desktop: the "Download [Report Name] (.xlsx)" button downloads a real, openable file with a sensible filename for at least three different report types.
65. Excel download on iPad: the same download button works by tap, and the file is accessible afterward.
66. Repeated download: clicking the same download button a second time, or asking the same export question again in a new conversation, succeeds again without error and produces the same figures.
67. Tampered request: manually editing the browser's request to change an allowlisted filter/column/grouping value is either honored (if still a valid, registered option for that report) or safely rejected -- it can never reach an unregistered field or another organization's data.
68. Cross-organization rejection: a report requested for one organization never contains another organization's records, vendors, items, or documents, and a spoofed organization id in the request has no effect.
69. Range-over-maximum: requesting a transactional report's date range beyond its maximum (90 days) is refused with a clear message from both the chat tool and, if hit directly, the download route.
70. No database mutation: no inventory, purchasing, receiving, waste, cycle-count, alert, or any other record is created, changed, or posted at any point while preparing or downloading any report -- read-only throughout, confirmed by checking no new rows appear anywhere.

---

## P. Final outcome

- [ ] Every scenario above is marked **Pass**, **Fail**, or **Not
      Applicable**.
- [ ] A screenshot is attached for every **Fail**.
- [ ] The exact route and timestamp is recorded for every **Fail**.
- [ ] No production promotion occurs while any P0 or P1 failure remains
      open.
- [ ] Final sign-off recorded below.

**Owner sign-off:** ____________________  **Date:** ____________
