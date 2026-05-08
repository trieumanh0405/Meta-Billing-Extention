# Meta Ads Billing Automation - Chrome Extension

## Project Context
A Manifest V3 Chrome Extension designed to automate the extraction of Meta Ads billing data (Invoices/VAT) and synchronize it with Google Drive (PDF uploads) and Google Sheets (master log). Developed to replace manual accounting workflows for 1990 Agency.

## Architecture

### Components
1. **`manifest.json`**: V3, requires `storage`, `identity`, `scripting`, `activeTab`, `tabs`. Host permissions include Meta Billing, Google APIs, and `https://graph.facebook.com/*` for auto-detect.
2. **`content.js` (Scraper Engine)**: Multi-strategy DOM parser (HTML `<table>`, ARIA grid, text-based) injected into Meta Billing pages. It sets the requested Meta date range, expands pagination, extracts transaction rows, filters by date, and fetches invoice PDFs.
3. **`background.js` (Service Worker)**: Orchestrator that manages Google OAuth2 token (`refreshAuthToken`), Meta Graph auto-detect, visible sequential multi-account scraping, Google Drive uploads, Google Sheets upserts, and persisted job state.
4. **`popup.html/js` (UI)**: Extension popup with Single-page mode and Multi-account controls. Polls `background.js` via `GET_PROGRESS`, shows persisted job logs, and supports Start, Pause, Resume, Stop, and Refresh Session.
5. **`options.html/js`**: Configuration UI for Sheet ID, Drive Folder ID, Meta Business Manager ID, Meta Graph API token, default date range, and delays.
6. **`lib/multiAccountHelpers.mjs` + `tests/multiAccountHelpers.test.mjs`**: Testable pure helpers for account parsing, billing URL candidates, date parsing/filtering, spend extraction, and job control state.

## Key Mechanisms & Fixes Developed

1. **PDF Fetch Logic**:
   - Instead of a naive binary blob fetch, the `content.js` checks the `Content-Type` of the URL. If Meta returns HTML (a detail page), it parses the HTML via Regex (`download_invoice` patterns) to locate the actual PDF download link.
   - Prevents `message channel closed` errors by ignoring `chrome.tabs.sendMessage` rejections and waiting for asynchronous responses via `chrome.runtime.onMessage` listeners.

2. **Google API Scopes & Shared Drives**:
   - Switched from `drive.file` to `drive` to allow the extension to read the user's pre-existing Drive folder for PDF uploads.
   - Added `supportsAllDrives=true` and `includeItemsFromAllDrives=true` to Drive API search, delete, and upload requests to support Google Workspace Shared Drives and prevent 404 File Not Found errors.
   - `background.js` uses a `refreshAuthToken` wrapper around `chrome.identity` to force clear old tokens if the scope changes or a 404 is encountered.

3. **Background Progress Polling**:
   - UI (`popup.js`) polls `background.js` every 1 second during single-page processing to stream real-time logs (PDF upload status, Google Sheet updates) without blocking the UI thread.
   - Guards against duplicate scrape clicks using an `isRunning` flag.

4. **Stable Multi-Account Runner**:
   - Multi Account now runs sequentially in visible tabs, not hidden tabs, to reduce Meta render/session issues.
   - `chrome.storage.local.multiAccountJobState` persists `jobId`, `status`, date range, accounts, results, totals, logs, `shouldStop`, and `shouldPause`.
   - Each account is retried up to 3 attempts (initial + 2 retries). A failed account is recorded and the batch continues.
   - Final status is `done` only when all accounts succeed; otherwise it becomes `completed_with_issues`.
   - Delay between accounts is enforced at a minimum of 20 seconds, with 0-10 seconds of random jitter. Even if old Options storage still has `7000`, `getRandomizedAccountDelayMs()` clamps it to 20-30 seconds to reduce Meta temporary block risk.

5. **Meta Auto-Detect with Spend Window**:
   - Auto-detect runs in `background.js`, not the popup, so closing the popup does not kill discovery.
   - Uses Business Manager ID to fetch `owned_ad_accounts` and `client_ad_accounts`, then falls back to `/me/adaccounts`.
   - Follows Graph pagination and calls account `insights` with `time_range={since,until}` only to annotate/log spend.
   - Graph spend is not used as a hard filter anymore. All accessible accounts are scraped in Billing UI because invoice presence is the source of truth.

6. **Date Range Control on Meta Billing UI**:
   - `content.js` opens the Meta date picker and verifies the label changes from the default range (e.g. `9 Apr 2026 - 6 May 2026`) to the requested range (e.g. `1 Apr 2026 - 30 Apr 2026`) before scraping.
   - First strategy sets date inputs if present.
   - Fallback strategy clicks calendar day cells directly when Meta renders a calendar grid without start/end inputs.
   - If the range cannot be verified, the account fails loudly instead of silently scraping an incomplete visible range.

7. **PDF Fetch Retry and Request Isolation**:
   - Each invoice PDF fetch has a 60-second timeout and 2 retries after the first attempt.
   - `requestId` is attached to every PDF request/response so late responses from timed-out invoices cannot be mistaken for the next invoice.
   - If PDF upload still fails, the row is still written to Sheet with a blank Drive link; rerunning later upserts by Transaction ID.

8. **Pause, Resume, and Refresh Session**:
   - Pause is cooperative and takes effect at safe checkpoints: before the next account, before the next transaction, or during delay/retry waits. It does not abort an active PDF upload mid-request.
   - Resume only works while the background runner is still active. If the MV3 worker was interrupted, use Refresh Session and start a new scrape.
   - Refresh Session clears persisted job state and logs, but is blocked while a scrape is running.

9. **Performance / Machine Slowdown Notes**:
   - The extension does **not** declare `content_scripts` in `manifest.json`; `content.js` is injected only when Single Page or Multi Account scraping explicitly runs. It should not scrape every Meta page in the background while idle.
   - Expected slowdown while running comes from heavy Meta Billing UI rendering, visible tab navigation, date-picker automation, table DOM parsing, PDF fetches through the logged-in Meta session, Drive uploads, Sheet upserts, and popup progress/log polling.
   - If Chrome feels slow while the scrape is not running, first check whether the popup is still open, whether many `business.facebook.com` tabs remain open, and whether the persisted job log is very large.
   - Current likely optimization targets: cap persisted job logs to the most recent 300-500 lines, render popup logs incrementally instead of `job.log.join('\n')` on every poll, and keep `content.js` debug logging disabled by default.
   - Auto-detect all accessible accounts is intentionally safer but slower than spend-filtered scraping. If speed becomes more important than completeness, add an explicit UI mode: `Safe mode: all accessible accounts` vs `Fast mode: Graph spend accounts + manual accounts`.

10. **Apps Script Campaign Extraction (`apps-script/Code.gs`)**:
   - Google Sheet now has a bound Apps Script flow named `Invoice Extractor` for extracting campaign-level rows from invoice PDFs already written to `Master`.
   - It uses Gemini API model `gemini-2.5-flash` with `GEMINI_API_KEY` stored in Apps Script `ScriptProperties`.
   - `setup()` creates/maintains `_Extraction_Log`, hides it when possible, and installs a 5-minute time-driven trigger for `processPendingInvoices()`.
   - Do not use `onEdit` / `onChange` for this workflow: `Master` is written by Sheets API from the Chrome extension, and Apps Script edit/change triggers do not reliably fire for API writes.
   - Eligibility rule is strict: only rows with `Payment Status = Paid`, non-empty `VAT invoice ID`, and non-empty Drive PDF `Link` are extracted. Rows that fail this gate do not call Gemini.
   - `processPendingInvoices()` scans existing `Master` rows and processes up to `DEFAULT_BATCH_SIZE` invoices per run, currently 5. To backfill all existing invoices, run `Invoice Extractor > Process pending invoices now` repeatedly or let the 5-minute trigger continue until all eligible rows are `SUCCESS`.
   - `processSelectedMasterRow()` is the manual one-row test path: select any cell in a valid `Master` row, run the menu item, then verify the corresponding `YYYY-MM` tab.
   - `resetSelectedInvoice()` removes the selected invoice's monthly output rows and `_Extraction_Log` entry so the same invoice can be retested cleanly.
   - Monthly output tabs are named `YYYY-MM` and use headers: `Date`, `VAT invoice ID`, `Campaign`, `Amount (chưa VAT)`. One invoice can create many rows, one per campaign line.
   - Idempotency is by `VAT invoice ID`: reprocessing the same invoice deletes/replaces old monthly rows for that invoice instead of duplicating them.
   - `_Extraction_Log` statuses: `SUCCESS`, `PROCESSING`, `WAITING_FOR_LINK`, `WAITING_FOR_VAT_INVOICE_ID`, `SKIPPED_PAYMENT_STATUS`, and `ERROR`.
   - `ERROR` rows retry until `Retry Count` reaches 2, then are skipped until manually reset.

## Setup Requirements (For Team Installation)
1. Must use Chrome or Microsoft Edge.
2. Enable "Developer mode" in Extensions.
3. Unzip the teammate package and load the unzipped folder as an unpacked extension. The selected folder must contain `manifest.json`.
4. Copy the generated Extension ID from `chrome://extensions`.
5. If Google auth fails, create or edit a GCP OAuth 2.0 Client ID of type `Chrome Extension`, paste that teammate Extension ID, then copy the resulting OAuth Client ID back into `manifest.json > oauth2.client_id`.
6. Reload the unpacked extension after any `manifest.json` change.
7. Click the extension icon -> Options to set Sheet ID, Drive Folder ID, Business Manager ID, Meta Token if using auto-detect, and Delay Between Accounts.
8. Delay Between Accounts should be at least `20000`. The runner enforces a 20s minimum plus 0-10s jitter even if old storage contains `7000`.
9. Teammates should read `INSTALL_FOR_TEAMMATE.md` before running Multi Account mode.

## Release Packaging Notes
- Teammate zip should include runtime files (`manifest.json`, `background.js`, `content.js`, popup/options files, icons, `lib/`) plus `README.md`, `INSTALL_FOR_TEAMMATE.md`, `docs/KNOWLEDGE_BASE.md`, and `apps-script/` for the Sheet campaign extraction workflow.
- Exclude local noise such as `.DS_Store`, `dist/`, caches, and generated zip files.
- After unzipping, load the inner extension folder in Chrome, not the zip file itself.

## Master Sheet Schema
- Date
- Ad Account Name
- Transaction ID
- Link (Drive PDF link)
- Amount (có VAT)
- Payment Method
- Payment Status
- VAT invoice ID

## Apps Script Backfill Workflow
1. In Google Sheet, run `Invoice Extractor > Setup / install 5-min trigger`.
2. Run `Invoice Extractor > Process pending invoices now` to immediately process the first batch of existing eligible `Master` rows.
3. Repeat `Process pending invoices now` for faster backfill, or wait for the 5-minute trigger to process the next batch automatically.
4. Monitor `_Extraction_Log`: `SUCCESS` means extracted; `SKIPPED_PAYMENT_STATUS` means not Paid; `WAITING_FOR_VAT_INVOICE_ID` means VAT ID is blank; `WAITING_FOR_LINK` means PDF link is blank.
5. Keep `DEFAULT_BATCH_SIZE` at 5 for safer Apps Script runtime. Increase cautiously to 10 or 20 only if test runs are stable and Gemini latency is low.
