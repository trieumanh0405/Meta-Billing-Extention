const MIN_AD_ACCOUNT_ID_LENGTH = 3;
const MIN_ACCOUNT_DELAY_MS = 20000;
const ACCOUNT_DELAY_JITTER_MS = 10000;

export function normalizeAccountId(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const parenthesized = raw.match(/\((\d{3,})\)/);
  if (parenthesized) return parenthesized[1];
  const actMatch = raw.match(/act[_=:-]?(\d{3,})/i);
  if (actMatch) return actMatch[1];
  const digitGroups = raw.match(/\d{3,}/g);
  if (!digitGroups) return '';
  const longest = digitGroups.sort((a, b) => b.length - a.length)[0];
  return longest.length >= MIN_AD_ACCOUNT_ID_LENGTH ? longest : '';
}

export function parseManualAccounts(raw) {
  if (!raw || !String(raw).trim()) return [];

  return dedupeAccounts(String(raw)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => ({
      id: normalizeAccountId(line),
      name: line,
      source: 'manual',
      spendInRange: null,
      detectStatus: 'manual',
    }))
    .filter(account => account.id));
}

export function buildBillingUrlCandidates(businessId, accountId) {
  const cleanBusinessId = normalizeAccountId(businessId) || String(businessId || '').replace(/\D/g, '');
  const cleanAccountId = normalizeAccountId(accountId);
  const latestParams = new URLSearchParams();

  if (cleanBusinessId) latestParams.set('business_id', cleanBusinessId);
  latestParams.set('asset_id', cleanAccountId);

  return [
    `https://business.facebook.com/latest/billing_hub/payment_activity?${latestParams.toString()}`,
    `https://business.facebook.com/billing_hub/payment_activity?act=${encodeURIComponent(cleanAccountId)}`,
  ];
}

export function parseMetaDate(value) {
  if (!value) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) return makeDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = Number(slash[3]);
    const month = first > 12 ? second : first;
    const day = first > 12 ? first : second;
    return makeDate(year, month, day);
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return makeDate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
}

export function isDateInRange(value, dateFrom, dateTo) {
  const date = parseMetaDate(value);
  const from = parseMetaDate(dateFrom);
  const to = parseMetaDate(dateTo);
  if (!date) return false;
  if (from && compareDateOnly(date, from) < 0) return false;
  if (to && compareDateOnly(date, to) > 0) return false;
  return true;
}

export function filterTransactionsByDate(transactions, dateFrom, dateTo) {
  const from = parseMetaDate(dateFrom);
  const to = parseMetaDate(dateTo);
  const kept = [];
  let droppedBeforeRange = 0;
  let droppedAfterRange = 0;
  let invalidDateCount = 0;
  let oldestDate = null;
  let newestDate = null;

  for (const tx of transactions || []) {
    const parsedDate = parseMetaDate(tx.date);
    if (!parsedDate) {
      invalidDateCount += 1;
      continue;
    }

    oldestDate = !oldestDate || compareDateOnly(parsedDate, oldestDate) < 0 ? parsedDate : oldestDate;
    newestDate = !newestDate || compareDateOnly(parsedDate, newestDate) > 0 ? parsedDate : newestDate;

    if (from && compareDateOnly(parsedDate, from) < 0) {
      droppedBeforeRange += 1;
      continue;
    }
    if (to && compareDateOnly(parsedDate, to) > 0) {
      droppedAfterRange += 1;
      continue;
    }
    kept.push(tx);
  }

  return {
    transactions: kept,
    droppedBeforeRange,
    droppedAfterRange,
    invalidDateCount,
    oldestDate: oldestDate ? toIsoDate(oldestDate) : '',
    newestDate: newestDate ? toIsoDate(newestDate) : '',
    rangeMayBeIncomplete: Boolean(from && oldestDate && compareDateOnly(oldestDate, from) > 0),
  };
}

export function formatDateForMetaInput(value) {
  const date = parseMetaDate(value);
  if (!date) return '';
  return `${MONTH_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

export function formatShortDateForMetaLabel(value) {
  const date = parseMetaDate(value);
  if (!date) return '';
  return `${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function isRequestedRangeVisibleInText(text, dateFrom, dateTo) {
  const normalized = normalizeRangeText(text);
  const fromLabel = normalizeRangeText(formatShortDateForMetaLabel(dateFrom));
  const toLabel = normalizeRangeText(formatShortDateForMetaLabel(dateTo));
  return Boolean(fromLabel && toLabel && normalized.includes(fromLabel) && normalized.includes(toLabel));
}

export function extractSpendInRange(insightsResponse) {
  if (!insightsResponse || insightsResponse.error) return 0;
  return (insightsResponse.data || []).reduce((sum, row) => {
    const spend = Number.parseFloat(row.spend || '0');
    return sum + (Number.isFinite(spend) ? spend : 0);
  }, 0);
}

export function normalizeMetaAccount(raw, fallbackSource = 'meta') {
  const id = normalizeAccountId(raw?.id || raw?.account_id || raw?.accountId);
  if (!id) return null;
  return {
    id,
    name: raw?.name || raw?.account_name || raw?.accountName || id,
    source: raw?.source || fallbackSource,
    spendInRange: raw?.spendInRange ?? null,
    detectStatus: raw?.detectStatus || 'detected',
  };
}

export function dedupeAccounts(accounts) {
  const byId = new Map();

  for (const raw of accounts || []) {
    const account = normalizeMetaAccount(raw, raw?.source || 'meta');
    if (!account) continue;

    const existing = byId.get(account.id);
    if (!existing || scoreAccount(account) > scoreAccount(existing)) {
      byId.set(account.id, account);
    }
  }

  return Array.from(byId.values());
}

export function createInitialJobState({ jobId, dateFrom, dateTo, accounts, now = () => new Date().toISOString() }) {
  return {
    jobId,
    status: 'running',
    dateFrom,
    dateTo,
    accounts: (accounts || []).map(account => ({
      ...account,
      status: account.status || 'queued',
      attempts: account.attempts || 0,
    })),
    currentIndex: 0,
    totals: {
      accountsDone: 0,
      accountsFailed: 0,
      accountsSkipped: 0,
      transactionsFound: 0,
      transactionsSaved: 0,
      pdfsUploaded: 0,
    },
    results: [],
    log: [],
    shouldStop: false,
    shouldPause: false,
    createdAt: now(),
    updatedAt: now(),
  };
}

export function appendJobLog(state, message, now = () => new Date().toISOString()) {
  const stamp = formatLogTime(now());
  return {
    ...state,
    log: [...(state.log || []), `[${stamp}] ${message}`].slice(-500),
    updatedAt: now(),
  };
}

export function updateAccountStatus(state, index, status, patch = {}) {
  const accounts = [...(state.accounts || [])];
  const existing = accounts[index] || {};
  accounts[index] = {
    ...existing,
    ...patch,
    status,
  };

  return {
    ...state,
    accounts,
    currentIndex: index,
    updatedAt: new Date().toISOString(),
  };
}

export function recordAccountResult(state, result) {
  const status = result.status || 'done';
  const currentIndex = Math.max(0, state.currentIndex || 0);
  const accounts = [...(state.accounts || [])];
  if (accounts[currentIndex]) {
    accounts[currentIndex] = {
      ...accounts[currentIndex],
      status,
      lastError: result.error || '',
    };
  }

  return {
    ...state,
    accounts,
    results: [...(state.results || []), result],
    totals: {
      accountsDone: (state.totals?.accountsDone || 0) + (status === 'done' ? 1 : 0),
      accountsFailed: (state.totals?.accountsFailed || 0) + (status === 'failed' ? 1 : 0),
      accountsSkipped: (state.totals?.accountsSkipped || 0) + (status === 'skipped' ? 1 : 0),
      transactionsFound: (state.totals?.transactionsFound || 0) + (result.transactionsFound || 0),
      transactionsSaved: (state.totals?.transactionsSaved || 0) + (result.transactionsSaved || 0),
      pdfsUploaded: (state.totals?.pdfsUploaded || 0) + (result.pdfsUploaded || 0),
    },
    updatedAt: new Date().toISOString(),
  };
}

export function markJobPaused(state, now = () => new Date().toISOString()) {
  return {
    ...state,
    status: 'paused',
    shouldPause: true,
    pausedAt: now(),
    updatedAt: now(),
  };
}

export function markJobResumed(state, now = () => new Date().toISOString()) {
  return {
    ...state,
    status: 'running',
    shouldPause: false,
    resumedAt: now(),
    updatedAt: now(),
  };
}

export function resetJobState() {
  return null;
}

export function getRandomizedAccountDelayMs(configuredDelayMs, random = Math.random) {
  const configured = Number(configuredDelayMs);
  const baseDelay = Number.isFinite(configured) && configured > 0
    ? Math.max(configured, MIN_ACCOUNT_DELAY_MS)
    : MIN_ACCOUNT_DELAY_MS;
  const roll = Math.min(0.999999999, Math.max(0, Number(random()) || 0));
  const jitter = Math.floor(roll * (ACCOUNT_DELAY_JITTER_MS + 1));
  return baseDelay + jitter;
}

function scoreAccount(account) {
  return [
    account.detectStatus === 'included' ? 1000 : 0,
    Number(account.spendInRange || 0) > 0 ? 100 : 0,
    account.name && account.name !== account.id ? 10 : 0,
  ].reduce((sum, score) => sum + score, 0);
}

function makeDate(year, month, day) {
  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function compareDateOnly(a, b) {
  return toDateNumber(a) - toDateNumber(b);
}

function toDateNumber(date) {
  return (date.getUTCFullYear() * 10000) + ((date.getUTCMonth() + 1) * 100) + date.getUTCDate();
}

function toIsoDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function formatLogTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '00:00:00';
  return [
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
    String(date.getUTCSeconds()).padStart(2, '0'),
  ].join(':');
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function normalizeRangeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[–—]/g, '-')
    .trim()
    .toLowerCase();
}
