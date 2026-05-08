import {
  appendJobLog,
  buildBillingUrlCandidates,
  createInitialJobState,
  dedupeAccounts,
  extractSpendInRange,
  getRandomizedAccountDelayMs,
  markJobPaused,
  markJobResumed,
  normalizeAccountId,
  parseManualAccounts,
  recordAccountResult,
  resetJobState,
  updateAccountStatus,
} from './lib/multiAccountHelpers.mjs';

/* ============================================================
 * background.js — Service Worker (orchestrator)
 * v1.1 — Fixed billing URL format, added businessId, better logging
 * ============================================================ */

// ── Config defaults ──────────────────────────────────────────
const DEFAULTS = {
  delayMin: 5000,
  delayMax: 10000,
  downloadDelay: 2500,
  pdfFetchTimeout: 60000,
  pdfFetchRetries: 2,
  pdfRetryDelay: 3000,
  pageReadyTimeout: 60000,
  accountRetryCount: 2,
};

const GRAPH_VERSION = 'v24.0';
const JOB_STATE_KEY = 'multiAccountJobState';

// ── State ────────────────────────────────────────────────────
let isRunning = false;
let shouldStop = false;
let shouldPause = false;
let currentProgress = { current: 0, total: 0, accountName: '', log: [] };
let activeJobState = null;
let persistMultiLogs = false;

// ── Helpers ──────────────────────────────────────────────────

function randomDelay(min = DEFAULTS.delayMin, max = DEFAULTS.delayMax) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}

function log(msg) {
  const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
  currentProgress.log.push(entry);
  if (persistMultiLogs && activeJobState) {
    activeJobState = appendJobLog(activeJobState, msg);
  }
  console.log('[MetaBilling BG]', msg);
}

function storageSyncGet(defaults) {
  return new Promise(resolve => {
    chrome.storage.sync.get(defaults, resolve);
  });
}

function storageLocalGet(keys) {
  return new Promise(resolve => {
    chrome.storage.local.get(keys, resolve);
  });
}

function storageLocalSet(values) {
  return new Promise(resolve => {
    chrome.storage.local.set(values, resolve);
  });
}

async function loadJobState() {
  const data = await storageLocalGet([JOB_STATE_KEY]);
  return data[JOB_STATE_KEY] || null;
}

async function saveJobState(state) {
  activeJobState = state;
  await storageLocalSet({ [JOB_STATE_KEY]: state });
  return state;
}

async function mutateJobState(updater) {
  const current = activeJobState || await loadJobState();
  if (!current) return null;
  const next = updater(current);
  return await saveJobState(next);
}

async function jobLog(msg) {
  const state = activeJobState || await loadJobState();
  if (!state) {
    log(msg);
    return null;
  }
  const next = appendJobLog(state, msg);
  console.log('[MetaBilling Multi]', msg);
  currentProgress.log = next.log;
  return await saveJobState(next);
}

async function pauseIfRequested() {
  while (shouldPause && !shouldStop) {
    const state = activeJobState || await loadJobState();
    if (state && state.status !== 'paused') {
      await saveJobState(markJobPaused(state));
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function delayWithPause(ms) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ms) {
    if (shouldStop) return;
    await pauseIfRequested();
    const remaining = ms - (Date.now() - startedAt);
    await new Promise(r => setTimeout(r, Math.min(500, Math.max(0, remaining))));
  }
}

async function requestPauseJob() {
  shouldPause = true;
  await mutateJobState(state => appendJobLog(markJobPaused(state), '⏸️ Pause requested — will pause at the next safe checkpoint'));
}

async function requestResumeJob() {
  if (!isRunning) {
    throw new Error('Cannot resume because the background runner is no longer active. Refresh Session and start a new scrape.');
  }
  shouldPause = false;
  await mutateJobState(state => appendJobLog(markJobResumed(state), '▶️ Resume requested'));
}

async function refreshScrapeSession() {
  shouldStop = false;
  shouldPause = false;
  activeJobState = resetJobState();
  currentProgress = { current: 0, total: 0, accountName: '', log: [] };
  await storageLocalSet({ [JOB_STATE_KEY]: null });
}

async function setJobStatus(status, patch = {}) {
  return await mutateJobState(state => ({
    ...state,
    ...patch,
    status,
    updatedAt: new Date().toISOString(),
  }));
}

async function getConfig() {
  return await storageSyncGet({
    sheetId: '',
    driveFolderId: '',
    metaToken: '',
    businessId: '',
    defaultDateFrom: '2026-01-01',
    delayBetweenAccounts: 20000,
  });
}

// ── Google Auth ──────────────────────────────────────────────

function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

/** Clear cached token and get a fresh one with updated scopes */
async function refreshAuthToken() {
  try {
    const oldToken = await getAuthToken(false).catch(() => null);
    if (oldToken) {
      await new Promise(resolve => {
        chrome.identity.removeCachedAuthToken({ token: oldToken }, resolve);
      });
      log('🔄 Cleared cached token, requesting new one...');
    }
    return await getAuthToken(true);
  } catch (err) {
    throw new Error(`Auth refresh failed: ${err.message}`);
  }
}

// ── Google Drive Upload ──────────────────────────────────────

async function getOrCreateDriveFolder(token, parentFolderId, folderName) {
  // Check if folder exists
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${encodeURIComponent(folderName)}'+and+mimeType='application/vnd.google-apps.folder'+and+'${parentFolderId}'+in+parents+and+trashed=false&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const searchResp = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const searchData = await searchResp.json();

  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }

  // Create folder
  const metadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentFolderId],
  };

  const createResp = await fetch(
    'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!createResp.ok) {
    const err = await createResp.text();
    throw new Error(`Folder creation failed: ${err}`);
  }

  const fileData = await createResp.json();
  return fileData.id;
}

async function uploadToDrive(token, fileName, pdfBase64, folderId) {
  // Check if file already exists (for overwrite) - including Shared Drives support
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${encodeURIComponent(fileName)}'+and+'${folderId}'+in+parents+and+trashed=false&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const searchResp = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const searchData = await searchResp.json();

  // Delete existing file if found (overwrite)
  if (searchData.files && searchData.files.length > 0) {
    for (const f of searchData.files) {
      await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?supportsAllDrives=true`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      log(`  Overwrote existing: ${f.name}`);
    }
  }

  // Upload new file via multipart
  const metadata = {
    name: fileName,
    parents: [folderId],
    mimeType: 'application/pdf',
  };

  const boundary = '---MetaBillingScraper';
  const body = [
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\n`,
    'Content-Type: application/pdf\r\n',
    'Content-Transfer-Encoding: base64\r\n\r\n',
    pdfBase64,
    `\r\n--${boundary}--`,
  ].join('');

  const uploadResp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!uploadResp.ok) {
    const err = await uploadResp.text();
    throw new Error(`Drive upload failed: ${err}`);
  }

  const fileData = await uploadResp.json();
  return fileData.webViewLink || `https://drive.google.com/file/d/${fileData.id}/view`;
}

// ── Google Sheets ────────────────────────────────────────────

async function findRowByTransactionId(token, sheetId, transactionId) {
  const range = encodeURIComponent('Master!C:C');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    log(`  ⚠️ Sheet read error: ${resp.status}`);
    return -1;
  }

  const data = await resp.json();
  const values = data.values || [];
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === transactionId) return i + 1; // 1-indexed
  }
  return -1;
}

async function writeSheetRow(token, sheetId, rowData, existingRow) {
  if (existingRow > 0) {
    // Overwrite existing row
    const range = encodeURIComponent(`Master!A${existingRow}:H${existingRow}`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [rowData] }),
    });
    if (!resp.ok) {
      log(`  ⚠️ Sheet overwrite failed: ${resp.status}`);
      return false;
    }
    return true;
  } else {
    // Append new row
    const range = encodeURIComponent('Master!A:H');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [rowData] }),
    });
    if (!resp.ok) {
      log(`  ⚠️ Sheet append failed: ${resp.status}`);
      return false;
    }
    return true;
  }
}

// ── Content Script Injection ─────────────────────────────────

async function injectAndScrape(tabId, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('Scrape timeout (90s) — page may not have loaded'));
    }, 90000);

    const listener = (message, sender) => {
      if (sender.tab?.id === tabId && message.type === 'SCRAPE_RESULT') {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(message.data);
      } else if (sender.tab?.id === tabId && message.type === 'SCRAPE_ERROR') {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        reject(new Error(message.error));
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    chrome.scripting.executeScript({
      target: { tabId },
      func: scrapeOptions => {
        window.__metaBillingScraperOptions = scrapeOptions || {};
        window.__metaBillingScraper = false;
      },
      args: [options],
    }).then(() => chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    })).catch(err => {
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
      reject(err);
    });
  });
}

// ── Fetch invoice PDF via content script ─────────────────────

async function fetchInvoicePdf(tabId, invoiceUrl, requestId = buildRequestId('pdf'), timeoutMs = DEFAULTS.pdfFetchTimeout) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error(`PDF fetch timeout (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    const listener = (message, sender) => {
      if (sender.tab?.id !== tabId || message.requestId !== requestId) return;

      if (message.type === 'PDF_RESULT') {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(message.base64);
      } else if (message.type === 'PDF_ERROR') {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        reject(new Error(message.error));
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    // Send FETCH_PDF to content script
    // NOTE: We intentionally ignore the sendMessage promise rejection.
    // The content script responds via chrome.runtime.sendMessage (not sendResponse),
    // so the message channel closing is expected and harmless.
    chrome.tabs.sendMessage(tabId, {
      type: 'FETCH_PDF',
      url: invoiceUrl,
      requestId,
    }).catch(() => {
      // Ignore "message channel closed" — this is expected.
      // The actual response comes through the onMessage listener above.
    });
  });
}

async function fetchInvoicePdfWithRetry(tabId, tx) {
  const label = tx.vatInvoiceId || tx.transactionId;
  let lastError = null;

  for (let attempt = 1; attempt <= DEFAULTS.pdfFetchRetries + 1; attempt++) {
    try {
      if (attempt > 1) {
        log(`  🔁 Retrying PDF for ${label} (${attempt}/${DEFAULTS.pdfFetchRetries + 1})`);
      }
      return await fetchInvoicePdf(tabId, tx.downloadUrl, buildRequestId(`pdf_${tx.transactionId || label}`));
    } catch (err) {
      lastError = err;
      if (attempt <= DEFAULTS.pdfFetchRetries) {
        log(`  ⚠️ PDF attempt ${attempt} failed for ${label}: ${err.message}`);
        await delayWithPause(DEFAULTS.pdfRetryDelay * attempt);
      }
    }
  }

  throw lastError || new Error('PDF fetch failed');
}

// ── Build billing URL ────────────────────────────────────────

function buildBillingUrl(businessId, accountId) {
  return buildBillingUrlCandidates(businessId, accountId)[0];
}

function buildJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildRequestId(prefix) {
  const safePrefix = String(prefix || 'req').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
  return `${safePrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function fetchGraphJson(pathOrUrl, params, token) {
  const url = pathOrUrl.startsWith('https://')
    ? pathOrUrl
    : `https://graph.facebook.com/${GRAPH_VERSION}/${pathOrUrl.replace(/^\//, '')}?${new URLSearchParams({
      ...params,
      access_token: token,
    }).toString()}`;

  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    const message = data.error?.message || `HTTP ${resp.status}`;
    throw new Error(message);
  }
  return data;
}

async function fetchGraphCollection(path, params, token) {
  let nextUrl = null;
  const rows = [];
  let page = 0;

  do {
    const data = await fetchGraphJson(nextUrl || path, nextUrl ? {} : params, token);
    rows.push(...(data.data || []));
    nextUrl = data.paging?.next || null;
    page++;
  } while (nextUrl && page < 25);

  return rows;
}

async function detectAccountsWithSpend(config, dateFrom, dateTo) {
  const token = config.metaToken;
  const businessId = normalizeAccountId(config.businessId) || config.businessId;
  if (!token) throw new Error('Missing Meta token for auto-detect');

  const fields = 'id,account_id,name,account_status';
  const rawAccounts = [];
  const sources = businessId
    ? [
      { label: 'owned', path: `${businessId}/owned_ad_accounts` },
      { label: 'client', path: `${businessId}/client_ad_accounts` },
    ]
    : [];

  sources.push({ label: 'fallback', path: 'me/adaccounts' });

  await jobLog(`🔍 Auto-detecting accounts for ${dateFrom} → ${dateTo}`);

  for (const source of sources) {
    if (shouldStop) break;
    try {
      const rows = await fetchGraphCollection(source.path, {
        fields,
        limit: '100',
      }, token);

      rows.forEach(row => {
        rawAccounts.push({
          ...row,
          source: source.label,
        });
      });
      await jobLog(`  ${source.label}: ${rows.length} accounts returned`);
    } catch (err) {
      await jobLog(`  ⚠️ ${source.label} detect failed: ${err.message}`);
    }
  }

  const accountStatusById = new Map();
  rawAccounts.forEach(raw => {
    const id = normalizeAccountId(raw.id || raw.account_id);
    if (id && raw.account_status !== undefined) accountStatusById.set(id, String(raw.account_status));
  });

  const candidates = dedupeAccounts(rawAccounts);

  const included = [];
  let spendPositive = 0;
  let checked = 0;

  for (const account of candidates) {
    if (shouldStop) break;
    checked++;
    try {
      const data = await fetchGraphJson(`act_${account.id}/insights`, {
        fields: 'spend',
        time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
        limit: '10',
      }, token);
      const spendInRange = extractSpendInRange(data);

      if (spendInRange > 0) {
        spendPositive++;
        included.push({
          ...account,
          spendInRange,
          detectStatus: 'included',
          accountStatus: accountStatusById.get(account.id) || '',
        });
        await jobLog(`  ✅ ${account.name}: spend ${spendInRange}`);
      } else {
        included.push({
          ...account,
          spendInRange: 0,
          detectStatus: 'included_no_spend',
          accountStatus: accountStatusById.get(account.id) || '',
        });
        await jobLog(`  🔎 ${account.name}: no spend in Graph, still included for billing check`);
      }
    } catch (err) {
      included.push({
        ...account,
        spendInRange: null,
        detectStatus: 'included_insights_failed',
        accountStatus: accountStatusById.get(account.id) || '',
      });
      await jobLog(`  ⚠️ ${account.name}: insights failed (${err.message}) — still included for billing check`);
    }

    if (checked % 10 === 0) {
      await randomDelay(250, 500);
    }
  }

  await jobLog(`Auto-detect will scrape ${included.length}/${candidates.length} accessible accounts (${spendPositive} with Graph spend)`);
  return dedupeAccounts(included);
}

async function waitForTabComplete(tabId, timeoutMs = 45000) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === 'complete') return;

  await new Promise(resolve => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(checkLoad);
      resolve();
    }, timeoutMs);

    const checkLoad = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(checkLoad);
        clearTimeout(timeout);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(checkLoad);
  });
}

async function inspectBillingPage(tabId, expectedAccountId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: accountId => {
      const text = document.body?.innerText || document.body?.textContent || '';
      const url = window.location.href;
      const lower = text.toLowerCase();
      return {
        url,
        title: document.title,
        loginRequired: url.includes('/login') || lower.includes('log in to facebook') || lower.includes('đăng nhập'),
        hasBillingSignal: /billing|payment activity|transaction|giao dịch|invoice|hóa đơn/i.test(text),
        hasTableSignal: Boolean(document.querySelector('table, [role="table"], [role="grid"], [role="treegrid"]')) ||
          /Transaction ID|Mã giao dịch|No transactions|Không có giao dịch/i.test(text),
        accountVisible: !accountId || url.includes(accountId) || text.includes(accountId),
        bodySample: text.replace(/\s+/g, ' ').trim().slice(0, 240),
      };
    },
    args: [normalizeAccountId(expectedAccountId)],
  });

  return results?.[0]?.result || {};
}

async function waitForBillingPageReady(tabId, expectedAccountId, timeoutMs = DEFAULTS.pageReadyTimeout) {
  const startedAt = Date.now();
  let lastInspection = {};

  while (Date.now() - startedAt < timeoutMs) {
    lastInspection = await inspectBillingPage(tabId, expectedAccountId).catch(err => ({
      error: err.message,
    }));

    if (lastInspection.loginRequired) {
      throw new Error('Meta login required or session expired');
    }

    if (lastInspection.hasBillingSignal && lastInspection.hasTableSignal) {
      return lastInspection;
    }

    await randomDelay(1000, 1600);
  }

  throw new Error(`Billing page not ready: ${lastInspection.bodySample || lastInspection.error || 'unknown state'}`);
}

// ── Process single page (scrape + upload + write) ────────────

function getMonthFolderName(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "Unknown_Month";
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const y = d.getFullYear();
  return `${y}-${m}`;
}

async function processScrapedData(transactions, accountName, googleToken, config, tabId) {
  let totalPdfs = 0;
  let rowsWritten = 0;
  const monthFolderCache = {};

  for (const tx of transactions) {
    if (shouldStop) break;
    await pauseIfRequested();

    let driveLink = '';

    // Try to download and upload invoice PDF
    if (tx.downloadUrl && config.driveFolderId && tabId) {
      try {
        const monthFolderName = getMonthFolderName(tx.date);
        let targetFolderId = monthFolderCache[monthFolderName];
        
        if (!targetFolderId) {
          targetFolderId = await getOrCreateDriveFolder(googleToken, config.driveFolderId, monthFolderName);
          monthFolderCache[monthFolderName] = targetFolderId;
          log(`  📁 Resolved subfolder: ${monthFolderName}`);
        }

        const pdfBase64 = await fetchInvoicePdfWithRetry(tabId, tx);
        if (pdfBase64) {
          const fileName = `${tx.vatInvoiceId || tx.transactionId}.pdf`;
          driveLink = await uploadToDrive(googleToken, fileName, pdfBase64, targetFolderId);
          totalPdfs++;
          log(`  📄 Uploaded to ${monthFolderName}: ${fileName}`);
        }
      } catch (err) {
        log(`  ⚠️ PDF failed for ${tx.vatInvoiceId || tx.transactionId}: ${err.message}`);
      }
      await delayWithPause(DEFAULTS.downloadDelay);
    }

    // Write to Sheet
    if (config.sheetId) {
      const rowData = [
        tx.date,
        accountName,
        tx.transactionId,
        driveLink,
        tx.amount,
        tx.paymentMethod,
        tx.paymentStatus,
        tx.vatInvoiceId,
      ];

      try {
        const existingRow = await findRowByTransactionId(googleToken, config.sheetId, tx.transactionId);
        const wrote = await writeSheetRow(googleToken, config.sheetId, rowData, existingRow);
        if (wrote) {
          rowsWritten++;
          log(`  ✏️ Sheet: ${existingRow > 0 ? 'updated' : 'appended'} row for ${tx.transactionId}`);
        }
      } catch (err) {
        log(`  ⚠️ Sheet write failed: ${err.message}`);
      }
    }

    if (persistMultiLogs && activeJobState) {
      await saveJobState(activeJobState);
    }
  }

  return { pdfsUploaded: totalPdfs, rowsWritten };
}

// ── Main Multi-Account Scrape ────────────────────────────────

async function startScrapeJob({ accounts = [], accountInput = '', autoDetect = true, dateFrom, dateTo }) {
  if (isRunning) {
    await jobLog('Already running — ignored duplicate start request');
    return;
  }

  const manualAccounts = dedupeAccounts([
    ...(accounts || []),
    ...parseManualAccounts(accountInput || ''),
  ]);

  activeJobState = createInitialJobState({
    jobId: buildJobId(),
    dateFrom,
    dateTo,
    accounts: manualAccounts,
  });
  await saveJobState(activeJobState);

  isRunning = true;
  shouldStop = false;
  shouldPause = false;
  persistMultiLogs = true;
  currentProgress = { current: 0, total: manualAccounts.length, accountName: '', log: [] };

  try {
    await jobLog('🚀 Multi Account job started');
    const config = await getConfig();

    if (!config.sheetId || !config.driveFolderId) {
      await failCurrentJob('Missing Sheet ID or Drive Folder ID — configure in Options');
      return;
    }

    let finalAccounts = manualAccounts;
    if (autoDetect) {
      await setJobStatus('detecting');
      try {
        const detectedAccounts = await detectAccountsWithSpend(config, dateFrom, dateTo);
        finalAccounts = dedupeAccounts([...detectedAccounts, ...manualAccounts]);
      } catch (err) {
        await jobLog(`⚠️ Auto-detect failed: ${err.message}`);
        finalAccounts = manualAccounts;
      }
    }

    if (finalAccounts.length === 0) {
      await failCurrentJob('No accounts to scrape. Auto-detect found none and no manual accounts were supplied.');
      return;
    }

    await mutateJobState(state => ({
      ...state,
      status: 'running',
      accounts: finalAccounts.map(account => ({
        ...account,
        status: account.status || 'queued',
        attempts: 0,
      })),
      updatedAt: new Date().toISOString(),
    }));

    currentProgress.total = finalAccounts.length;
    await jobLog(`Scraping ${finalAccounts.length} accounts sequentially in visible tabs`);

    let googleToken;
    try {
      googleToken = await refreshAuthToken();
      await jobLog('✅ Google auth OK (fresh token)');
    } catch (err) {
      await failCurrentJob(`Google auth failed: ${err.message}`);
      return;
    }

    for (let i = 0; i < finalAccounts.length; i++) {
      if (shouldStop) {
        await jobLog('⛔ Stopped by user');
        await setJobStatus('stopped', { shouldStop: true });
        break;
      }
      await pauseIfRequested();

      currentProgress.current = i + 1;
      currentProgress.accountName = finalAccounts[i].name || finalAccounts[i].id;

      await mutateJobState(state => ({
        ...state,
        currentIndex: i,
        updatedAt: new Date().toISOString(),
      }));

      const result = await runAccountWithRetry(finalAccounts[i], i, finalAccounts.length, googleToken, config, dateFrom, dateTo);
      await mutateJobState(state => recordAccountResult(state, result));

      if (i < finalAccounts.length - 1 && !shouldStop) {
        const delay = getRandomizedAccountDelayMs(config.delayBetweenAccounts);
        await jobLog(`  Waiting ${(delay / 1000).toFixed(1)}s before next account`);
        await delayWithPause(delay);
      }
    }

    const latest = activeJobState || await loadJobState();
    if (latest?.status !== 'stopped' && latest?.status !== 'failed') {
      const hasIssues = (latest.totals.accountsFailed || 0) > 0 || (latest.totals.accountsSkipped || 0) > 0;
      await setJobStatus(hasIssues ? 'completed_with_issues' : 'done');
      const prefix = hasIssues ? '⚠️ Multi Account completed with issues' : '✅ Multi Account done';
      await jobLog(`${prefix}: ${latest.totals.transactionsFound} transactions, ${latest.totals.pdfsUploaded} PDFs uploaded, ${latest.totals.accountsFailed} failed, ${latest.totals.accountsSkipped} skipped`);
    }
  } catch (err) {
    await failCurrentJob(err.message || 'Unknown multi-account error');
  } finally {
    isRunning = false;
    persistMultiLogs = false;
  }
}

async function failCurrentJob(message) {
  await jobLog(`❌ ${message}`);
  await setJobStatus('failed', { error: message });
  isRunning = false;
}

async function runAccountWithRetry(account, index, total, googleToken, config, dateFrom, dateTo) {
  const maxAttempts = DEFAULTS.accountRetryCount + 1;
  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (shouldStop) {
      return buildAccountResult(account, 'skipped', 'Stopped by user');
    }
    await pauseIfRequested();

    await jobLog(`\n📋 [${index + 1}/${total}] ${account.name || account.id} — attempt ${attempt}/${maxAttempts}`);
    await mutateJobState(state => updateAccountStatus(state, index, 'opening', { attempts: attempt }));

    try {
      const result = await runSingleAccount(account, index, googleToken, config, dateFrom, dateTo);
      return result;
    } catch (err) {
      lastError = err.message;
      await jobLog(`  ⚠️ Attempt ${attempt} failed: ${lastError}`);
      if (attempt < maxAttempts) await delayWithPause(Math.floor(Math.random() * 2001) + 2500);
    }
  }

  await mutateJobState(state => updateAccountStatus(state, index, 'failed', { lastError }));
  return buildAccountResult(account, 'failed', lastError);
}

async function runSingleAccount(account, index, googleToken, config, dateFrom, dateTo) {
  const urls = buildBillingUrlCandidates(config.businessId, account.id);
  let tab = null;
  let lastError = '';

  try {
    for (const url of urls) {
      if (shouldStop) throw new Error('Stopped by user');
      await pauseIfRequested();

      await jobLog(`  Opening: ${url}`);
      await mutateJobState(state => updateAccountStatus(state, index, 'opening', { currentUrl: url }));

      if (!tab) {
        tab = await chrome.tabs.create({ url, active: true });
      } else {
        await chrome.tabs.update(tab.id, { url, active: true });
      }

      await waitForTabComplete(tab.id);
      await mutateJobState(state => updateAccountStatus(state, index, 'verifying', { currentUrl: url }));

      try {
        const inspection = await waitForBillingPageReady(tab.id, account.id);
        if (!inspection.accountVisible) {
          await jobLog('  ⚠️ Account ID not visible on page; continuing because billing table is ready');
        }
        break;
      } catch (err) {
        lastError = err.message;
        await jobLog(`  ⚠️ Page verification failed: ${err.message}`);
        if (url === urls[urls.length - 1]) throw err;
      }
    }

    await mutateJobState(state => updateAccountStatus(state, index, 'scraping'));
    await pauseIfRequested();
    const scrapeData = await injectAndScrape(tab.id, {
      dateFrom,
      dateTo,
      expectedAccountId: account.id,
    });

    const diagnostics = scrapeData.diagnostics || {};
    if (diagnostics.dateRange?.requested) {
      await jobLog(`  Date range: ${diagnostics.dateRange.beforeLabel || 'unknown'} → ${diagnostics.dateRange.afterLabel || 'unknown'}`);
    }
    if (diagnostics.rangeMayBeIncomplete) {
      await jobLog('  ⚠️ Page range may not cover requested range; verify rows manually if totals look low');
    }
    if (diagnostics.invalidDateCount) {
      await jobLog(`  ⚠️ Ignored ${diagnostics.invalidDateCount} rows with unrecognized dates`);
    }

    const transactions = scrapeData.transactions || [];
    await jobLog(`  Found ${transactions.length} transactions in selected date range`);

    await mutateJobState(state => updateAccountStatus(state, index, 'uploading'));
    const accountName = scrapeData.accountName || account.name || account.id;
    const processing = await processScrapedData(transactions, accountName, googleToken, config, tab.id);

    await mutateJobState(state => updateAccountStatus(state, index, 'sheet_written'));
    await jobLog(`  Saved ${processing.rowsWritten} rows, uploaded ${processing.pdfsUploaded} PDFs`);

    return {
      accountId: account.id,
      accountName,
      transactionsFound: transactions.length,
      transactionsSaved: processing.rowsWritten,
      pdfsUploaded: processing.pdfsUploaded,
      status: 'done',
      error: '',
    };
  } finally {
    if (tab?.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

function buildAccountResult(account, status, error = '') {
  return {
    accountId: account.id,
    accountName: account.name || account.id,
    transactionsFound: 0,
    transactionsSaved: 0,
    pdfsUploaded: 0,
    status,
    error,
  };
}

// ── Message Handler ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'START_SCRAPE':
      if (isRunning) {
        sendResponse({ error: 'Already processing — please wait' });
        break;
      }
      startScrapeJob({
        accounts: message.accounts || [],
        accountInput: message.accountInput || '',
        autoDetect: message.autoDetect !== false,
        dateFrom: message.dateFrom,
        dateTo: message.dateTo,
      }).catch(err => {
        console.error('[MetaBilling Multi] fatal', err);
        failCurrentJob(err.message || 'Unknown multi-account failure');
      });
      sendResponse({ ok: true });
      break;

    case 'STOP_SCRAPE':
      shouldStop = true;
      shouldPause = false;
      mutateJobState(state => appendJobLog({
        ...state,
        shouldStop: true,
        status: state.status === 'done' ? 'done' : 'stopping',
      }, 'Stop requested')).catch(() => {});
      sendResponse({ ok: true });
      break;

    case 'PAUSE_SCRAPE':
      requestPauseJob()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'RESUME_SCRAPE':
      requestResumeJob()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'REFRESH_SCRAPE_SESSION':
      if (isRunning) {
        sendResponse({ error: 'Cannot refresh while a scrape is running. Pause/stop first, then refresh.' });
        break;
      }
      refreshScrapeSession()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'GET_PROGRESS':
      (async () => {
        let job = activeJobState || await loadJobState();
        if (job && ['running', 'detecting', 'stopping'].includes(job.status) && !isRunning) {
          job = {
            ...job,
            status: 'interrupted',
            error: 'Background worker restarted before the job finished. Start again from the last successful account.',
            updatedAt: new Date().toISOString(),
          };
          await saveJobState(job);
        }

        sendResponse({
          isRunning,
          ...currentProgress,
          job,
        });
      })();
      return true;

    case 'SCRAPE_CURRENT_PAGE':
      // Guard against duplicate calls
      if (isRunning) {
        sendResponse({ error: 'Already processing — please wait' });
        break;
      }

      // Single-page mode: scrape the active tab, then process in background
      (async () => {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab) {
          sendResponse({ error: 'No active tab found' });
          return;
        }

        // Check if tab URL is a Meta billing page
        if (!activeTab.url?.includes('business.facebook.com')) {
          sendResponse({ error: 'Not a Meta Business page. Navigate to Billing > Payment Activity first.' });
          return;
        }

        // Reset progress for polling
        currentProgress = { current: 0, total: 0, accountName: '', log: [] };
        isRunning = true;
        log('📄 Single page mode — scraping current tab');

        try {
          const data = await injectAndScrape(activeTab.id);
          log(`Found ${data.transactions.length} transactions on current page`);

          // Send initial response immediately so popup can show results
          sendResponse({ ok: true, data });

          // Continue processing in background (PDF upload + sheet write)
          if (data.transactions.length > 0) {
            const config = await getConfig();
            let googleToken = null;
            try {
              // Use refreshAuthToken to ensure we have the latest scope (drive vs drive.file)
              googleToken = await refreshAuthToken();
              log('✅ Google auth OK (fresh token)');
            } catch (err) {
              log(`⚠️ Google auth failed: ${err.message} — data scraped but not saved`);
            }

            if (googleToken && config.sheetId) {
              const accountName = data.accountName || 'Unknown';
              const processing = await processScrapedData(
                data.transactions, accountName, googleToken, config, activeTab.id
              );
              log(`✅ Done: ${processing.rowsWritten} rows written, ${processing.pdfsUploaded} PDFs uploaded`);
            }
          }
        } catch (err) {
          log(`❌ Scrape failed: ${err.message}`);
          sendResponse({ error: err.message });
        }

        isRunning = false;
      })();
      return true; // Keep message channel open for async

    default:
      break;
  }
});
