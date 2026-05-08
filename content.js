/* ============================================================
 * content.js — Injected into Meta Billing Hub pages
 * Scrapes transaction table + extracts invoice PDF download URLs
 * v1.1 — Rewritten with robust DOM parsing & debug logging
 * ============================================================ */

(async function () {
  'use strict';

  const scrapeOptions = window.__metaBillingScraperOptions || {};

  // Avoid concurrent runs, but allow deliberate re-runs on the same tab.
  if (window.__metaBillingScraperActive) return;
  window.__metaBillingScraper = true;
  window.__metaBillingScraperActive = true;

  const DEBUG = true;
  function dbg(...args) {
    if (DEBUG) console.log('[MetaBilling]', ...args);
  }

  // ── Utilities ────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /** Parse VND amount string: "đ20,300,000" or "₫20.300.000" → "20300000" */
  function parseAmount(str) {
    if (!str) return '';
    // Remove all non-digit characters
    return str.replace(/[^\d]/g, '');
  }

  function parseMetaDate(value) {
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
    const aValue = (a.getUTCFullYear() * 10000) + ((a.getUTCMonth() + 1) * 100) + a.getUTCDate();
    const bValue = (b.getUTCFullYear() * 10000) + ((b.getUTCMonth() + 1) * 100) + b.getUTCDate();
    return aValue - bValue;
  }

  function toIsoDate(date) {
    return [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    ].join('-');
  }

  function filterTransactionsByDate(transactions, dateFrom, dateTo) {
    const from = parseMetaDate(dateFrom);
    const to = parseMetaDate(dateTo);
    if (!from && !to) {
      return {
        transactions,
        droppedBeforeRange: 0,
        droppedAfterRange: 0,
        invalidDateCount: 0,
        rangeMayBeIncomplete: false,
      };
    }

    const kept = [];
    let droppedBeforeRange = 0;
    let droppedAfterRange = 0;
    let invalidDateCount = 0;
    let oldestDate = null;

    for (const tx of transactions) {
      const parsedDate = parseMetaDate(tx.date);
      if (!parsedDate) {
        invalidDateCount++;
        continue;
      }

      oldestDate = !oldestDate || compareDateOnly(parsedDate, oldestDate) < 0 ? parsedDate : oldestDate;

      if (from && compareDateOnly(parsedDate, from) < 0) {
        droppedBeforeRange++;
        continue;
      }
      if (to && compareDateOnly(parsedDate, to) > 0) {
        droppedAfterRange++;
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
      rangeMayBeIncomplete: Boolean(from && oldestDate && compareDateOnly(oldestDate, from) > 0),
    };
  }

  function formatDateForMetaInput(value) {
    const date = parseMetaDate(value);
    if (!date) return '';
    return `${MONTH_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
  }

  function formatDateForNativeInput(value) {
    const date = parseMetaDate(value);
    if (!date) return '';
    return toIsoDate(date);
  }

  function formatShortDateForMetaLabel(value) {
    const date = parseMetaDate(value);
    if (!date) return '';
    return `${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }

  function isRequestedRangeVisibleInText(text, dateFrom, dateTo) {
    const normalized = normalizeRangeText(text);
    const fromLabel = normalizeRangeText(formatShortDateForMetaLabel(dateFrom));
    const toLabel = normalizeRangeText(formatShortDateForMetaLabel(dateTo));
    return Boolean(fromLabel && toLabel && normalized.includes(fromLabel) && normalized.includes(toLabel));
  }

  function normalizeRangeText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/[–—]/g, '-')
      .trim()
      .toLowerCase();
  }

  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /** Clean cell text — remove extra whitespace, newlines */
  function cleanText(el) {
    if (!el) return '';
    // Get text content but skip hidden elements
    return el.textContent.replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function setNativeValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    input.blur();
  }

  function findDateRangeTrigger() {
    const rangePattern = /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\s*[-–—]\s*\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b/;
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
      .filter(isVisible);

    for (const el of candidates) {
      const text = cleanText(el);
      if (!rangePattern.test(text)) continue;
      return el.closest('button, [role="button"]') || el;
    }

    return null;
  }

  function getVisibleDatePickerRoots() {
    const roots = Array.from(document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [data-testid], div'))
      .filter(isVisible)
      .filter(el => {
        const text = cleanText(el).toLowerCase();
        if (!/(custom|date|apply|cancel|start|end|tùy chỉnh|ngày|áp dụng|hủy)/i.test(text)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 180 && rect.height >= 80 && rect.height < window.innerHeight * 0.95;
      });

    return roots.sort((a, b) => {
      const za = Number.parseInt(window.getComputedStyle(a).zIndex || '0', 10) || 0;
      const zb = Number.parseInt(window.getComputedStyle(b).zIndex || '0', 10) || 0;
      return zb - za;
    });
  }

  function getVisibleInputsWithin(roots) {
    const searchWords = /(search|transaction|reference|tìm kiếm|giao dịch|tham chiếu)/i;
    const inputs = [];
    for (const root of roots) {
      root.querySelectorAll('input').forEach(input => {
        if (!isVisible(input)) return;
        const meta = [
          input.type,
          input.placeholder,
          input.name,
          input.getAttribute('aria-label'),
          input.value,
        ].join(' ');
        if (searchWords.test(meta)) return;
        if (!['', 'text', 'date'].includes((input.type || '').toLowerCase())) return;
        if (!inputs.includes(input)) inputs.push(input);
      });
    }
    return inputs;
  }

  function clickTextButton(patterns) {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex], span'))
      .filter(isVisible);

    for (const el of candidates) {
      const text = cleanText(el).toLowerCase();
      if (patterns.some(pattern => pattern.test(text))) {
        const clickable = el.closest('button, [role="button"]') || el;
        clickable.click();
        return true;
      }
    }
    return false;
  }

  function monthKey(date) {
    return (date.getUTCFullYear() * 12) + date.getUTCMonth();
  }

  function parseVisibleMonthKeys(roots) {
    const keys = new Set();
    const yearPattern = /\b(20\d{2})\b/g;

    for (const root of roots) {
      const text = normalizeRangeText(cleanText(root));
      const years = Array.from(text.matchAll(yearPattern)).map(match => Number(match[1]));
      for (const year of years) {
        MONTH_SHORT.forEach((month, index) => {
          const shortName = month.toLowerCase();
          const longName = MONTH_LONG[index].toLowerCase();
          if (text.includes(`${shortName} ${year}`) || text.includes(`${longName} ${year}`)) {
            keys.add((year * 12) + index);
          }
        });
      }
    }

    return Array.from(keys).sort((a, b) => a - b);
  }

  function getMonthNavigationDirection(targetDate, roots) {
    const visibleKeys = parseVisibleMonthKeys(roots);
    if (visibleKeys.length === 0) return 0;

    const targetKey = monthKey(targetDate);
    if (targetKey < visibleKeys[0]) return -1;
    if (targetKey > visibleKeys[visibleKeys.length - 1]) return 1;
    return 0;
  }

  function findCalendarNavButton(roots, direction) {
    const prevPatterns = [
      /previous/, /\bprev\b/, /back/, /month before/, /trước/, /tháng trước/, /‹/, /◀/, /left/,
    ];
    const nextPatterns = [
      /next/, /forward/, /month after/, /sau/, /tháng sau/, /›/, /▶/, /right/,
    ];
    const patterns = direction < 0 ? prevPatterns : nextPatterns;
    const candidates = [];
    const seen = new Set();

    for (const root of roots) {
      root.querySelectorAll('button, [role="button"], [aria-label], [title]').forEach(el => {
        if (!isVisible(el) || isDisabledDateCell(el) || seen.has(el)) return;
        seen.add(el);
        const meta = normalizeRangeText([
          cleanText(el),
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('data-testid'),
        ].filter(Boolean).join(' '));
        if (!meta) return;
        if (patterns.some(pattern => pattern.test(meta))) {
          candidates.push(el.closest('button, [role="button"]') || el);
        }
      });
    }

    return candidates[0] || null;
  }

  async function navigateCalendarToMonth(date, maxClicks = 12) {
    for (let step = 0; step <= maxClicks; step++) {
      let roots = getPickerSearchRoots();
      if (findDateCell(date, roots, 50)) return true;

      const direction = getMonthNavigationDirection(date, roots);
      if (direction === 0 && step > 0) return false;

      const navButton = findCalendarNavButton(roots, direction || -1);
      if (!navButton) return false;

      navButton.click();
      await sleep(700);
    }
    return false;
  }

  function getPickerSearchRoots() {
    const roots = getVisibleDatePickerRoots();
    return roots.length ? roots : [document.body];
  }

  function getDatePickerDebugSnapshot(roots) {
    const buttons = [];
    const seen = new Set();

    for (const root of roots) {
      root.querySelectorAll('button, [role="button"], [role="gridcell"], [aria-label], [title], input').forEach(el => {
        if (!isVisible(el) || seen.has(el)) return;
        seen.add(el);
        const text = cleanText(el);
        const aria = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const dataDate = el.getAttribute('data-date') || el.getAttribute('data-testid') || '';
        const sample = [text, aria, title, dataDate].filter(Boolean).join(' | ');
        if (sample) buttons.push(sample.slice(0, 90));
      });
    }

    return buttons.slice(0, 18).join(' || ');
  }

  function dateMatchTokens(date) {
    const monthShort = MONTH_SHORT[date.getUTCMonth()];
    const monthLong = MONTH_LONG[date.getUTCMonth()];
    const day = String(date.getUTCDate());
    const paddedDay = day.padStart(2, '0');
    const year = String(date.getUTCFullYear());
    const iso = toIsoDate(date);

    return {
      day,
      paddedDay,
      year,
      iso,
      monthShort: monthShort.toLowerCase(),
      monthLong: monthLong.toLowerCase(),
      patterns: [
        `${monthShort} ${day}, ${year}`,
        `${monthLong} ${day}, ${year}`,
        `${day} ${monthShort} ${year}`,
        `${day} ${monthLong} ${year}`,
        `${paddedDay} ${monthShort} ${year}`,
        `${paddedDay} ${monthLong} ${year}`,
        iso,
      ].map(normalizeRangeText),
    };
  }

  function isDisabledDateCell(el) {
    return el.getAttribute('aria-disabled') === 'true' ||
      el.disabled ||
      /\bdisabled\b/i.test(el.className || '');
  }

  function nearbyMonthScore(el, tokens) {
    let current = el.parentElement;
    for (let depth = 0; depth < 8 && current; depth++) {
      const text = normalizeRangeText(cleanText(current));
      const hasMonth = text.includes(`${tokens.monthShort} ${tokens.year}`) ||
        text.includes(`${tokens.monthLong} ${tokens.year}`) ||
        text.includes(`${tokens.monthShort.toLowerCase()} ${tokens.year}`) ||
        text.includes(`${tokens.monthLong.toLowerCase()} ${tokens.year}`);
      if (hasMonth) return 20 - depth;
      current = current.parentElement;
    }
    return 0;
  }

  function scoreDateCell(el, date) {
    if (!isVisible(el) || isDisabledDateCell(el)) return 0;
    const tokens = dateMatchTokens(date);
    const meta = normalizeRangeText([
      cleanText(el),
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-date'),
      el.getAttribute('data-testid'),
    ].filter(Boolean).join(' '));

    if (tokens.patterns.some(pattern => pattern && meta.includes(pattern))) return 100;

    const text = normalizeRangeText(cleanText(el));
    const isDayOnly = text === tokens.day || text === tokens.paddedDay;
    if (!isDayOnly) return 0;

    const monthScore = nearbyMonthScore(el, tokens);
    if (monthScore > 0) return 50 + monthScore;

    // Last resort: date grids are usually ordered by month, and this is still
    // better than silently scraping the wrong visible range.
    return 5;
  }

  function findDateCell(date, roots, minScore = 1) {
    const candidates = [];
    const seen = new Set();

    for (const root of roots) {
      root.querySelectorAll('button, [role="button"], [role="gridcell"], [aria-label], [title], [data-date]').forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        const score = scoreDateCell(el, date);
        if (score >= minScore) candidates.push({ el, score });
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  async function clickDateCell(date, roots, label) {
    const cell = findDateCell(date, roots, 50) || findDateCell(date, roots, 100);
    if (!cell) return false;
    cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(150);
    const clickable = cell.closest('button, [role="button"]') || cell;
    clickable.click();
    dbg(`Clicked ${label} date cell:`, cleanText(cell), cell.getAttribute('aria-label') || cell.getAttribute('title') || '');
    await sleep(650);
    return true;
  }

  async function clickCalendarRange(dateFrom, dateTo, roots) {
    const from = parseMetaDate(dateFrom);
    const to = parseMetaDate(dateTo);
    if (!from || !to) return false;

    const startMonthVisible = await navigateCalendarToMonth(from);
    if (!startMonthVisible) return false;

    const clickedStart = await clickDateCell(from, getPickerSearchRoots(), 'start');
    if (!clickedStart) return false;

    const endMonthVisible = await navigateCalendarToMonth(to);
    if (!endMonthVisible) return false;

    const refreshedRoots = getPickerSearchRoots();
    const clickedEnd = await clickDateCell(to, refreshedRoots, 'end');
    return clickedEnd;
  }

  async function waitForDateLabel(dateFrom, dateTo, timeoutMs = 12000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const trigger = findDateRangeTrigger();
      const text = cleanText(trigger);
      if (isRequestedRangeVisibleInText(text, dateFrom, dateTo)) return text;
      await sleep(500);
    }
    return cleanText(findDateRangeTrigger());
  }

  async function applyRequestedDateRange() {
    const { dateFrom, dateTo } = scrapeOptions;
    if (!dateFrom || !dateTo) {
      return { requested: false, applied: false, beforeLabel: '', afterLabel: '' };
    }

    const beforeTrigger = findDateRangeTrigger();
    const beforeLabel = cleanText(beforeTrigger);
    dbg('Current date range label:', beforeLabel);

    if (isRequestedRangeVisibleInText(beforeLabel, dateFrom, dateTo)) {
      return { requested: true, applied: true, beforeLabel, afterLabel: beforeLabel };
    }

    if (!beforeTrigger) {
      throw new Error(`Could not find Meta date range picker for ${dateFrom} → ${dateTo}`);
    }

    beforeTrigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(300);
    beforeTrigger.click();
    await sleep(900);

    clickTextButton([/^custom$/, /custom range/, /tùy chỉnh/]);
    await sleep(600);

    const roots = getPickerSearchRoots();
    const inputs = getVisibleInputsWithin(roots);
    if (inputs.length >= 2) {
      const startValue = inputs[0].type === 'date' ? formatDateForNativeInput(dateFrom) : formatDateForMetaInput(dateFrom);
      const endValue = inputs[1].type === 'date' ? formatDateForNativeInput(dateTo) : formatDateForMetaInput(dateTo);
      setNativeValue(inputs[0], startValue);
      await sleep(200);
      setNativeValue(inputs[1], endValue);
      await sleep(400);
    } else {
      const clickedCalendarRange = await clickCalendarRange(dateFrom, dateTo, roots);
      if (!clickedCalendarRange) {
        throw new Error(`Date picker opened but no input or matching calendar day cells were found. Current label: ${beforeLabel}. Picker sample: ${getDatePickerDebugSnapshot(roots)}`);
      }
    }

    const applied = clickTextButton([/^apply$/, /^update$/, /^done$/, /^save$/, /^áp dụng$/, /^cập nhật$/, /^xong$/, /^lưu$/]);
    if (!applied && inputs.length >= 2) {
      inputs[1].dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    }

    const afterLabel = await waitForDateLabel(dateFrom, dateTo);
    if (!isRequestedRangeVisibleInText(afterLabel, dateFrom, dateTo)) {
      throw new Error(`Could not verify Meta date range changed to ${formatShortDateForMetaLabel(dateFrom)} - ${formatShortDateForMetaLabel(dateTo)}. Current label: ${afterLabel || beforeLabel}`);
    }

    await sleep(2500);
    return { requested: true, applied: true, beforeLabel, afterLabel };
  }

  /** Extract account name from the page */
  function getAccountName() {
    // Pattern 1: Look for "Ad account" heading area
    // The page shows: "1990 Agency – 03 – Gamuda Land (477531276669395)"
    const headings = document.querySelectorAll('h1, h2, h3, [role="heading"]');
    for (const h of headings) {
      const text = h.textContent.trim();
      if (text.match(/\(\d{10,}\)/) || text.includes('Ad account')) {
        dbg('Found account name via heading:', text);
        return text;
      }
    }

    // Pattern 2: Look for text containing account ID pattern near "Ad account" label
    const allSpans = document.querySelectorAll('span, div');
    for (const el of allSpans) {
      const text = el.textContent.trim();
      if (text.match(/^\d{12,18}$/) || text.match(/\(\d{12,18}\)/)) {
        // Found something with an account ID — get broader context
        const parent = el.closest('div');
        if (parent) {
          dbg('Found account name via ID pattern:', parent.textContent.trim().substring(0, 100));
          return parent.textContent.trim().substring(0, 100);
        }
      }
    }

    // Pattern 3: Look for the account selector dropdown at top-right
    const dropdowns = document.querySelectorAll('[aria-haspopup], [role="listbox"]');
    for (const d of dropdowns) {
      const text = d.textContent.trim();
      if (text.length > 10 && text.length < 120 && text.match(/\d{6,}/)) {
        dbg('Found account name via dropdown:', text);
        return text;
      }
    }

    dbg('Could not find account name');
    return '';
  }

  // ── "See More" Pagination ────────────────────────────────

  async function clickSeeMore() {
    let clicked = 0;
    while (true) {
      await sleep(500);

      // Look for "See more" / "Xem thêm" in various elements
      const candidates = document.querySelectorAll('div[role="button"], button, a, span');
      let seeMore = null;

      for (const el of candidates) {
        const text = el.textContent.trim().toLowerCase();
        if (
          (text === 'see more' || text === 'xem thêm') &&
          el.offsetParent !== null // Is visible
        ) {
          seeMore = el;
          break;
        }
      }

      if (!seeMore) {
        dbg(`No more "See more" button found after ${clicked} clicks`);
        break;
      }

      dbg(`Clicking "See more" (attempt ${clicked + 1})`);
      seeMore.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(300);
      seeMore.click();
      clicked++;
      await sleep(2000); // Wait for rows to load

      if (clicked > 50) {
        dbg('Safety limit reached for See More clicks');
        break;
      }
    }
    return clicked;
  }

  // ── Table Discovery ──────────────────────────────────────

  /**
   * Find the billing table using multiple strategies.
   * Returns { headerRow, dataRows } or null.
   */
  function findTable() {
    dbg('=== Starting table discovery ===');

    // Strategy 1: Standard HTML <table>
    const tables = document.querySelectorAll('table');
    dbg(`Found ${tables.length} <table> elements`);

    for (const table of tables) {
      const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
      if (!headerRow) continue;

      const headerText = headerRow.textContent.toLowerCase();
      dbg('Table header text:', headerText.substring(0, 200));

      if (headerText.includes('transaction') || headerText.includes('giao dịch')) {
        const tbody = table.querySelector('tbody');
        const dataRows = tbody
          ? tbody.querySelectorAll('tr')
          : table.querySelectorAll('tr:not(:first-child)');

        dbg(`Strategy 1 (HTML table): Found header + ${dataRows.length} data rows`);
        return {
          type: 'table',
          headerCells: headerRow.querySelectorAll('th, td'),
          dataRows: Array.from(dataRows),
        };
      }
    }

    // Strategy 2: ARIA table (div[role="table"], div[role="grid"])
    const ariaTables = document.querySelectorAll('[role="table"], [role="grid"], [role="treegrid"]');
    dbg(`Found ${ariaTables.length} ARIA table elements`);

    for (const ariaTable of ariaTables) {
      const headerRow = ariaTable.querySelector('[role="row"]');
      if (!headerRow) continue;

      const headerText = headerRow.textContent.toLowerCase();
      if (headerText.includes('transaction') || headerText.includes('giao dịch')) {
        const allRows = ariaTable.querySelectorAll('[role="row"]');
        const dataRows = Array.from(allRows).slice(1); // Skip header

        dbg(`Strategy 2 (ARIA table): Found header + ${dataRows.length} data rows`);
        return {
          type: 'aria',
          headerCells: headerRow.querySelectorAll('[role="columnheader"], [role="cell"]'),
          dataRows,
        };
      }
    }

    // Strategy 3: Text-based discovery — find "Transaction ID" header text
    dbg('Strategy 3: Text-based discovery');
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.children.length > 0) continue; // Only leaf text nodes
      const text = el.textContent.trim();
      if (text === 'Transaction ID' || text === 'Mã giao dịch') {
        dbg('Found "Transaction ID" text in:', el.tagName, el.className);

        // Walk up to find the row container
        let headerRow = el.parentElement;
        for (let i = 0; i < 8 && headerRow; i++) {
          // Check if this container has enough children to be a header row
          const directKids = headerRow.children.length;
          if (directKids >= 5) {
            dbg(`  Potential header row at level ${i}: ${directKids} children, tag=${headerRow.tagName}`);

            // The table container is the parent of this row
            const tableContainer = headerRow.parentElement;
            if (!tableContainer) continue;

            // Get sibling rows
            const siblingRows = Array.from(tableContainer.children).filter(
              child => child !== headerRow && child.children.length >= 3
            );
            dbg(`  Found ${siblingRows.length} potential data rows`);

            if (siblingRows.length > 0) {
              return {
                type: 'div',
                headerCells: Array.from(headerRow.children),
                dataRows: siblingRows,
              };
            }
          }
          headerRow = headerRow.parentElement;
        }
      }
    }

    dbg('❌ No table found with any strategy');
    return null;
  }

  // ── Column Mapping ───────────────────────────────────────

  function mapColumns(headerCells) {
    const colMap = {};
    const headers = Array.from(headerCells);

    headers.forEach((cell, idx) => {
      const text = cleanText(cell).toLowerCase();
      dbg(`  Column ${idx}: "${text}"`);

      if (text.match(/transaction\s*id|mã giao dịch/)) colMap.transactionId = idx;
      else if (text.match(/^date|ngày/)) colMap.date = idx;
      else if (text.match(/amount|số tiền/)) colMap.amount = idx;
      else if (text.match(/payment\s*method|phương thức/)) colMap.paymentMethod = idx;
      else if (text.match(/payment\s*status|trạng thái/)) colMap.paymentStatus = idx;
      else if (text.match(/vat\s*invoice|hóa đơn/i)) colMap.vatInvoiceId = idx;
      else if (text.match(/action|thao tác/i)) colMap.action = idx;
    });

    dbg('Column mapping:', JSON.stringify(colMap));
    return colMap;
  }

  // ── Row Extraction ───────────────────────────────────────

  function extractRowData(row, colMap, tableType) {
    let cells;

    if (tableType === 'table') {
      cells = row.querySelectorAll('td');
    } else if (tableType === 'aria') {
      cells = row.querySelectorAll('[role="cell"], [role="gridcell"]');
    } else {
      // div-based: direct children
      cells = row.children;
    }

    if (!cells || cells.length < 3) return null;

    const getCellText = (idx) => {
      if (idx === undefined || idx >= cells.length) return '';
      return cleanText(cells[idx]);
    };

    // Extract Transaction ID
    let transactionId = getCellText(colMap.transactionId);
    // Clean up: Transaction IDs may contain multiple IDs separated by space/newline
    // Take the first one
    const idMatch = transactionId.match(/(\d{10,})/);
    transactionId = idMatch ? idMatch[1] : transactionId.split(/\s/)[0];

    if (!transactionId || transactionId.length < 5) return null;

    // Extract download URL from action column
    let downloadUrl = '';
    if (colMap.action !== undefined && cells[colMap.action]) {
      const actionCell = cells[colMap.action];
      // Look for <a> tags
      const links = actionCell.querySelectorAll('a[href]');
      for (const link of links) {
        const href = link.href;
        if (href && (href.includes('download') || href.includes('invoice') || href.includes('billing'))) {
          downloadUrl = href;
          break;
        }
      }
      // If no matching href, check any link
      if (!downloadUrl && links.length > 0) {
        downloadUrl = links[0].href;
      }
      // Check for data attributes
      if (!downloadUrl) {
        const downloadEl = actionCell.querySelector('[data-href], [download], a');
        if (downloadEl) {
          downloadUrl = downloadEl.getAttribute('data-href') || downloadEl.getAttribute('href') || '';
        }
      }
    }

    // Also search the entire row for download links
    if (!downloadUrl) {
      const rowLinks = row.querySelectorAll('a[href*="download"], a[href*="invoice"], a[href*="billing_document"]');
      if (rowLinks.length > 0) downloadUrl = rowLinks[0].href;
    }

    // Extract VAT Invoice ID
    let vatInvoiceId = getCellText(colMap.vatInvoiceId);
    // Clean: sometimes has extra whitespace
    vatInvoiceId = vatInvoiceId.replace(/\s+/g, '');

    // Extract payment status
    let paymentStatus = getCellText(colMap.paymentStatus);
    // Fix duplicate text like "PaidPaid" or "FailedFailed" from screen-reader elements
    paymentStatus = paymentStatus.replace(/^(.*?)\s*\1$/i, '$1');

    // Extract payment method — may have icon text mixed in
    let paymentMethod = getCellText(colMap.paymentMethod);
    // Clean up: remove flag/icon artifacts
    paymentMethod = paymentMethod.replace(/^[\s\S]*?(Visa|Master\s*Card|JCB|Amex)/i, '$1');

    return {
      transactionId,
      date: getCellText(colMap.date),
      amount: parseAmount(getCellText(colMap.amount)),
      paymentMethod: paymentMethod || '',
      paymentStatus: paymentStatus || '',
      vatInvoiceId: vatInvoiceId || '',
      downloadUrl,
    };
  }

  // ── PDF Fetch Handler ────────────────────────────────────

  if (!window.__metaBillingScraperPdfListenerAttached) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'FETCH_PDF') {
        const requestId = message.requestId || '';
        dbg('Fetching PDF:', message.url);
        (async () => {
          try {
            const resp = await fetch(message.url, { credentials: 'include' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            const contentType = resp.headers.get('content-type') || '';
            dbg('PDF response Content-Type:', contentType);

            // Check if response is actually a PDF
            if (contentType.includes('application/pdf') || contentType.includes('application/octet-stream')) {
              const blob = await resp.blob();
              const reader = new FileReader();
              reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                dbg('PDF fetched successfully, size:', base64.length);
                chrome.runtime.sendMessage({ type: 'PDF_RESULT', base64, requestId });
              };
              reader.onerror = () => {
                chrome.runtime.sendMessage({ type: 'PDF_ERROR', error: 'FileReader error', requestId });
              };
              reader.readAsDataURL(blob);
            } else {
              // Response is HTML (transaction detail page), not a PDF
              // Try to find the actual download link in the response
              const html = await resp.text();
              dbg('Response is HTML, not PDF. Searching for download link in page...');

              // Look for invoice download URL patterns in the HTML
              const pdfUrlMatch = html.match(/href="([^"]*download_invoice[^"]*)"/i)
                || html.match(/href="([^"]*\.pdf[^"]*)"/i)
                || html.match(/"(https?:\/\/[^"]*invoice[^"]*download[^"]*)"/i);

              if (pdfUrlMatch) {
                dbg('Found PDF URL in HTML:', pdfUrlMatch[1]);
                // Fetch the actual PDF
                const pdfResp = await fetch(pdfUrlMatch[1], { credentials: 'include' });
                if (pdfResp.ok) {
                  const pdfBlob = await pdfResp.blob();
                  const reader = new FileReader();
                  reader.onloadend = () => {
                    const base64 = reader.result.split(',')[1];
                    dbg('PDF fetched from extracted URL, size:', base64.length);
                    chrome.runtime.sendMessage({ type: 'PDF_RESULT', base64, requestId });
                  };
                  reader.readAsDataURL(pdfBlob);
                  return;
                }
              }

              chrome.runtime.sendMessage({
                type: 'PDF_ERROR',
                error: `Not a PDF (Content-Type: ${contentType}). URL may be a detail page, not a download link.`,
                requestId,
              });
            }
          } catch (err) {
            dbg('PDF fetch error:', err);
            chrome.runtime.sendMessage({ type: 'PDF_ERROR', error: err.message, requestId });
          }
        })();
        return true;
      }

      // Handle CLICK_DOWNLOAD — programmatically click download button
      if (message.type === 'CLICK_DOWNLOAD') {
        dbg('Clicking download button for row index:', message.rowIndex);
        (async () => {
          try {
            // Find download buttons/icons in the table
            const actionCells = document.querySelectorAll('table tbody tr td:last-child, [role="row"] [role="cell"]:last-child');
            const idx = message.rowIndex;
            if (idx >= 0 && idx < actionCells.length) {
              const cell = actionCells[idx];
              const btn = cell.querySelector('a, button, [role="button"], svg');
              if (btn) {
                btn.click();
                dbg('Clicked download button at row', idx);
                await sleep(2000);
                chrome.runtime.sendMessage({ type: 'CLICK_DOWNLOAD_DONE' });
                return;
              }
            }
            chrome.runtime.sendMessage({ type: 'CLICK_DOWNLOAD_ERROR', error: 'Button not found' });
          } catch (err) {
            chrome.runtime.sendMessage({ type: 'CLICK_DOWNLOAD_ERROR', error: err.message });
          }
        })();
        return true;
      }
    });
    window.__metaBillingScraperPdfListenerAttached = true;
  }

  // ── Main Scrape Execution ────────────────────────────────

  try {
    dbg('=== Content script injected ===');
    dbg('URL:', window.location.href);

    // Wait for page to settle (React rendering)
    await sleep(3000);

    const dateRangeDiagnostics = await applyRequestedDateRange();
    dbg('Date range diagnostics:', JSON.stringify(dateRangeDiagnostics));

    // Check if we're on a valid billing page
    const pageText = document.body.textContent;
    if (pageText.includes('No transactions') || pageText.includes('Không có giao dịch')) {
      dbg('Page shows "No transactions"');
      chrome.runtime.sendMessage({
        type: 'SCRAPE_RESULT',
        data: {
          accountName: getAccountName(),
          transactions: [],
          diagnostics: {
            totalBeforeDateFilter: 0,
            droppedBeforeRange: 0,
            droppedAfterRange: 0,
            invalidDateCount: 0,
            rangeMayBeIncomplete: false,
            dateRange: dateRangeDiagnostics,
          },
        },
      });
      return;
    }

    // Click "See more" to load all rows
    const pagesLoaded = await clickSeeMore();
    dbg(`Pagination: loaded ${pagesLoaded} additional pages`);

    if (pagesLoaded > 0) {
      await sleep(1500);
    }

    // Get account name
    const accountName = getAccountName();
    dbg('Account name:', accountName);

    // Find and scrape the table
    const tableInfo = findTable();

    if (!tableInfo) {
      dbg('❌ Table not found — dumping page structure for debugging');
      // Dump some structural info for debugging
      const tables = document.querySelectorAll('table');
      const divTables = document.querySelectorAll('[role="table"], [role="grid"]');
      dbg(`  <table>: ${tables.length}, [role=table/grid]: ${divTables.length}`);
      dbg(`  Body children: ${document.body.children.length}`);

      // Try to find any table-like structure
      const ths = document.querySelectorAll('th');
      dbg(`  <th> elements: ${ths.length}`);
      ths.forEach((th, i) => dbg(`    th[${i}]: "${th.textContent.trim()}"`));

      chrome.runtime.sendMessage({
        type: 'SCRAPE_RESULT',
        data: {
          accountName,
          transactions: [],
          diagnostics: {
            tableFound: false,
            totalBeforeDateFilter: 0,
            droppedBeforeRange: 0,
            droppedAfterRange: 0,
            invalidDateCount: 0,
            rangeMayBeIncomplete: false,
            dateRange: dateRangeDiagnostics,
          },
        },
      });
      return;
    }

    // Map columns
    const colMap = mapColumns(tableInfo.headerCells);
    dbg(`Table type: ${tableInfo.type}, Data rows: ${tableInfo.dataRows.length}`);

    // Extract data from each row
    const transactions = [];
    for (const row of tableInfo.dataRows) {
      const rowData = extractRowData(row, colMap, tableInfo.type);
      if (rowData) {
        transactions.push(rowData);
        dbg(`  Row: ${rowData.date} | ${rowData.vatInvoiceId} | ${rowData.amount} | DL: ${rowData.downloadUrl ? 'YES' : 'NO'}`);
      }
    }

    const dateFiltered = filterTransactionsByDate(transactions, scrapeOptions.dateFrom, scrapeOptions.dateTo);
    dbg(`Date filter: ${transactions.length} → ${dateFiltered.transactions.length}`, scrapeOptions.dateFrom, scrapeOptions.dateTo);
    dbg(`=== Scrape complete: ${dateFiltered.transactions.length} transactions ===`);

    chrome.runtime.sendMessage({
      type: 'SCRAPE_RESULT',
      data: {
        accountName,
        transactions: dateFiltered.transactions,
        diagnostics: {
          tableFound: true,
          totalBeforeDateFilter: transactions.length,
          droppedBeforeRange: dateFiltered.droppedBeforeRange,
          droppedAfterRange: dateFiltered.droppedAfterRange,
          invalidDateCount: dateFiltered.invalidDateCount,
          oldestDate: dateFiltered.oldestDate || '',
          rangeMayBeIncomplete: dateFiltered.rangeMayBeIncomplete,
          dateRange: dateRangeDiagnostics,
        },
      },
    });

  } catch (err) {
    dbg('❌ Scrape error:', err);
    chrome.runtime.sendMessage({
      type: 'SCRAPE_ERROR',
      error: err.message || 'Unknown error',
    });
  } finally {
    window.__metaBillingScraperActive = false;
  }
})();
