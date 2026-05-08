var INVOICE_EXTRACTOR_CONFIG = {
  MASTER_SHEET_NAME: 'Master',
  LOG_SHEET_NAME: '_Extraction_Log',
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_API_KEY_PROPERTY: 'GEMINI_API_KEY',
  DEFAULT_BATCH_SIZE: 5,
  MAX_RETRY_COUNT: 2,
  TRIGGER_MINUTES: 5,
  MONTH_HEADERS: ['Date', 'VAT invoice ID', 'Campaign', 'Amount (chưa VAT)'],
  LOG_HEADERS: [
    'Transaction ID',
    'VAT invoice ID',
    'Drive Link',
    'Drive File ID',
    'Status',
    'Retry Count',
    'Rows Written',
    'Error',
    'Processed At',
    'Master Row',
    'Month Tab',
    'Updated At'
  ],
  REQUIRED_MASTER_HEADERS: ['Date', 'Transaction ID', 'Link', 'Payment Status', 'VAT invoice ID']
};

var GEMINI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    invoice_date: {
      type: 'string',
      description: 'Invoice/payment date if visible, otherwise empty string.'
    },
    vat_invoice_id: {
      type: 'string',
      description: 'VAT invoice ID if visible, otherwise empty string.'
    },
    campaigns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          campaign: {
            type: 'string',
            description: 'Full campaign name exactly as visible in the invoice campaign row.'
          },
          amount_chua_vat: {
            type: 'integer',
            description: 'Campaign amount before VAT as a VND integer without currency symbols or separators.'
          }
        },
        required: ['campaign', 'amount_chua_vat']
      }
    }
  },
  required: ['campaigns']
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Invoice Extractor')
    .addItem('Setup / install 5-min trigger', 'setup')
    .addItem('Process pending invoices now', 'processPendingInvoices')
    .addSeparator()
    .addItem('Process selected Master row', 'processSelectedMasterRow')
    .addItem('Reset selected invoice', 'resetSelectedInvoice')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logSheet = ensureExtractionLogSheet_(ss);
  hideSheetIfPossible_(logSheet);
  installPollingTrigger_();

  var apiKey = PropertiesService.getScriptProperties()
    .getProperty(INVOICE_EXTRACTOR_CONFIG.GEMINI_API_KEY_PROPERTY);
  var suffix = apiKey
    ? 'GEMINI_API_KEY is configured.'
    : 'Add GEMINI_API_KEY in Project Settings > Script properties before processing invoices.';
  notify_('Invoice Extractor setup complete. 5-minute trigger installed. ' + suffix);
}

function processPendingInvoices() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('Another invoice extraction run is active. Skipping this run.');
    return;
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var masterSheet = getMasterSheet_(ss);
    var logSheet = ensureExtractionLogSheet_(ss);
    var pendingRows = getPendingMasterRows_(
      masterSheet,
      logSheet,
      INVOICE_EXTRACTOR_CONFIG.DEFAULT_BATCH_SIZE
    );

    if (pendingRows.length === 0) {
      console.log('No pending invoice rows. Gemini API was not called.');
      return;
    }

    for (var i = 0; i < pendingRows.length; i++) {
      processMasterRowByNumber_(ss, masterSheet, pendingRows[i], {
        force: false,
        throwOnError: false
      });
    }
  } finally {
    lock.releaseLock();
  }
}

function processSelectedMasterRow() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    notify_('Another invoice extraction run is active. Try again in a moment.');
    return;
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var masterSheet = assertSelectedMasterSheet_(ss);
    var rowNumber = masterSheet.getActiveRange().getRow();
    assertDataRow_(rowNumber);

    var result = processMasterRowByNumber_(ss, masterSheet, rowNumber, {
      force: true,
      throwOnError: true
    });
    notify_(
      'Selected invoice processed: ' +
      result.status +
      '. Rows written: ' +
      (result.rowsWritten || 0) +
      '.'
    );
  } finally {
    lock.releaseLock();
  }
}

function resetSelectedInvoice() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    notify_('Another invoice extraction run is active. Try again in a moment.');
    return;
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var masterSheet = assertSelectedMasterSheet_(ss);
    var rowNumber = masterSheet.getActiveRange().getRow();
    assertDataRow_(rowNumber);

    var row = readMasterRow_(masterSheet, rowNumber);
    var fileId = parseDriveFileId(row.link);
    var logSheet = ensureExtractionLogSheet_(ss);
    var monthTabName = getMonthTabName(row.date);
    var invoiceId = row.vatInvoiceId || row.transactionId;
    var deletedRows = 0;

    if (invoiceId) {
      var monthSheet = ss.getSheetByName(monthTabName);
      if (monthSheet) {
        deletedRows = deleteRowsForInvoice_(monthSheet, invoiceId);
      }
    }

    var deletedLogRows = deleteLogEntry_(logSheet, getLogKey_(row, fileId));
    notify_(
      'Reset complete. Deleted monthly rows: ' +
      deletedRows +
      '. Deleted log rows: ' +
      deletedLogRows +
      '.'
    );
  } finally {
    lock.releaseLock();
  }
}

function processMasterRowByNumber_(ss, masterSheet, rowNumber, options) {
  options = options || {};
  var force = !!options.force;
  var throwOnError = !!options.throwOnError;
  var row = readMasterRow_(masterSheet, rowNumber);
  var fileId = parseDriveFileId(row.link);
  var logSheet = ensureExtractionLogSheet_(ss);
  var logKey = getLogKey_(row, fileId);
  var existingLog = getLogEntry_(logSheet, logKey);
  var eligibility = getInvoiceEligibility_(row);

  if (!eligibility.eligible) {
    return markRowNotEligible_(logSheet, row, logKey, fileId, existingLog, eligibility);
  }

  if (!force && shouldSkipLogEntry_(existingLog)) {
    return {
      status: existingLog.status,
      rowsWritten: existingLog.rowsWritten || 0,
      skipped: true
    };
  }

  if (!fileId) {
    var parseError = new Error('Could not parse Drive file ID from Link: ' + row.link);
    return markRowError_(logSheet, row, logKey, fileId, existingLog, parseError, throwOnError);
  }

  upsertLog_(logSheet, {
    transactionId: logKey,
    vatInvoiceId: row.vatInvoiceId,
    driveLink: row.link,
    driveFileId: fileId,
    status: 'PROCESSING',
    retryCount: existingLog ? existingLog.retryCount : 0,
    rowsWritten: 0,
    error: '',
    processedAt: '',
    masterRow: rowNumber,
    monthTab: getMonthTabName(row.date)
  });

  try {
    var pdfBlob = DriveApp.getFileById(fileId).getBlob();
    var extraction = extractInvoiceCampaignsWithGemini_(pdfBlob, row);
    var invoiceId = row.vatInvoiceId;

    if (!invoiceId) {
      throw new Error('Missing VAT invoice ID; cannot write idempotent output.');
    }

    var monthTab = getMonthTabName(row.date);
    var rowsWritten = writeCampaignRows_(ss, monthTab, row.date, invoiceId, extraction.campaigns);
    upsertLog_(logSheet, {
      transactionId: logKey,
      vatInvoiceId: invoiceId,
      driveLink: row.link,
      driveFileId: fileId,
      status: 'SUCCESS',
      retryCount: existingLog ? existingLog.retryCount : 0,
      rowsWritten: rowsWritten,
      error: '',
      processedAt: new Date(),
      masterRow: rowNumber,
      monthTab: monthTab
    });

    return { status: 'SUCCESS', rowsWritten: rowsWritten };
  } catch (err) {
    return markRowError_(logSheet, row, logKey, fileId, existingLog, err, throwOnError);
  }
}

function extractInvoiceCampaignsWithGemini_(pdfBlob, row) {
  var apiKey = PropertiesService.getScriptProperties()
    .getProperty(INVOICE_EXTRACTOR_CONFIG.GEMINI_API_KEY_PROPERTY);
  if (!apiKey) {
    throw new Error('Missing Script property GEMINI_API_KEY.');
  }

  var endpoint =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    INVOICE_EXTRACTOR_CONFIG.GEMINI_MODEL +
    ':generateContent?key=' +
    encodeURIComponent(apiKey);
  var payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: buildExtractionPrompt_(row) },
          {
            inlineData: {
              mimeType: 'application/pdf',
              data: Utilities.base64Encode(pdfBlob.getBytes())
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseJsonSchema: GEMINI_RESPONSE_SCHEMA
    }
  };

  var response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var statusCode = response.getResponseCode();
  var bodyText = response.getContentText();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('Gemini API failed with HTTP ' + statusCode + ': ' + shorten_(bodyText, 500));
  }

  var responseJson = JSON.parse(bodyText);
  var geminiText = extractTextFromGeminiResponse_(responseJson);
  var parsed = parseGeminiJson_(geminiText);
  return {
    vatInvoiceId: String(parsed.vat_invoice_id || '').trim(),
    campaigns: normalizeGeminiResult_(parsed)
  };
}

function buildExtractionPrompt_(row) {
  return [
    'You are extracting campaign spend lines from a Meta Ads tax invoice PDF.',
    'Return JSON only using the provided schema.',
    'Extract only top-level campaign rows under the Campaigns section.',
    'Do not include child/product/ad/adset/placement/detail rows such as PRO_Saved lines.',
    'For each campaign, return the full campaign name exactly as visible and its amount before VAT as a VND integer.',
    'If the same campaign appears on multiple separate invoice rows, return separate items.',
    'Do not compare totals against the Master subtotal.',
    '',
    'Master row context:',
    'Date: ' + formatDateForPrompt_(row.date),
    'Transaction ID: ' + row.transactionId,
    'VAT invoice ID: ' + row.vatInvoiceId,
    'Drive link: ' + row.link
  ].join('\n');
}

function writeCampaignRows_(ss, monthTabName, dateValue, invoiceId, campaigns) {
  if (!campaigns || campaigns.length === 0) {
    throw new Error('Gemini returned zero campaign rows.');
  }

  var monthSheet = ensureMonthSheet_(ss, monthTabName);
  deleteRowsForInvoice_(monthSheet, invoiceId);

  var rows = [];
  for (var i = 0; i < campaigns.length; i++) {
    rows.push([
      dateValue,
      invoiceId,
      campaigns[i].campaign,
      campaigns[i].amountChuaVat
    ]);
  }

  monthSheet
    .getRange(monthSheet.getLastRow() + 1, 1, rows.length, INVOICE_EXTRACTOR_CONFIG.MONTH_HEADERS.length)
    .setValues(rows);
  return rows.length;
}

function getPendingMasterRows_(masterSheet, logSheet, batchSize) {
  var values = masterSheet.getDataRange().getValues();
  if (values.length < 2) return [];

  var headerMap = buildHeaderMapFromValues_(values[0]);
  assertRequiredMasterHeaders_(headerMap);

  var logMap = readLogMap_(logSheet);
  var pendingRows = [];
  for (var i = 1; i < values.length; i++) {
    var row = buildMasterRowFromValues_(values[i], headerMap, i + 1);
    if (!hasAnyInvoiceSignal_(row)) continue;

    var fileId = parseDriveFileId(row.link);
    var logKey = getLogKey_(row, fileId);
    var existingLog = logMap[normalizeKey_(logKey)];
    var eligibility = getInvoiceEligibility_(row);

    if (!eligibility.eligible) {
      markRowNotEligible_(logSheet, row, logKey, fileId, existingLog, eligibility);
      continue;
    }

    if (shouldSkipLogEntry_(existingLog)) continue;

    pendingRows.push(row.rowNumber);
    if (pendingRows.length >= batchSize) break;
  }

  return pendingRows;
}

function shouldSkipLogEntry_(entry) {
  if (!entry) return false;
  if (entry.status === 'SUCCESS') return true;
  if (entry.status === 'ERROR' && entry.retryCount >= INVOICE_EXTRACTOR_CONFIG.MAX_RETRY_COUNT) {
    return true;
  }
  return false;
}

function getInvoiceEligibility_(row) {
  var status = String(row && row.paymentStatus || '').trim();
  if (!isPaidStatus_(status)) {
    return {
      eligible: false,
      status: 'SKIPPED_PAYMENT_STATUS',
      error: 'Payment Status must be Paid before extraction. Current value: ' + (status || '(blank)')
    };
  }

  if (!String(row && row.vatInvoiceId || '').trim()) {
    return {
      eligible: false,
      status: 'WAITING_FOR_VAT_INVOICE_ID',
      error: 'VAT invoice ID is blank in Master.'
    };
  }

  if (!String(row && row.link || '').trim()) {
    return {
      eligible: false,
      status: 'WAITING_FOR_LINK',
      error: 'Drive PDF link is blank in Master.'
    };
  }

  return { eligible: true, status: 'ELIGIBLE', error: '' };
}

function isPaidStatus_(value) {
  return String(value || '').trim().toLowerCase() === 'paid';
}

function markRowNotEligible_(logSheet, row, logKey, fileId, existingLog, eligibility) {
  upsertLog_(logSheet, {
    transactionId: logKey,
    vatInvoiceId: row.vatInvoiceId,
    driveLink: row.link,
    driveFileId: fileId,
    status: eligibility.status,
    retryCount: existingLog ? existingLog.retryCount : 0,
    rowsWritten: 0,
    error: eligibility.error,
    processedAt: '',
    masterRow: row.rowNumber,
    monthTab: getMonthTabName(row.date)
  });
  return { status: eligibility.status, rowsWritten: 0, skipped: true, error: eligibility.error };
}

function markRowError_(logSheet, row, logKey, fileId, existingLog, err, throwOnError) {
  var retryCount = existingLog ? existingLog.retryCount + 1 : 1;
  upsertLog_(logSheet, {
    transactionId: logKey,
    vatInvoiceId: row.vatInvoiceId,
    driveLink: row.link,
    driveFileId: fileId,
    status: 'ERROR',
    retryCount: retryCount,
    rowsWritten: 0,
    error: err && err.message ? err.message : String(err),
    processedAt: '',
    masterRow: row.rowNumber,
    monthTab: getMonthTabName(row.date)
  });

  if (throwOnError) throw err;
  return { status: 'ERROR', rowsWritten: 0, error: err && err.message ? err.message : String(err) };
}

function ensureExtractionLogSheet_(ss) {
  var sheet = ss.getSheetByName(INVOICE_EXTRACTOR_CONFIG.LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(INVOICE_EXTRACTOR_CONFIG.LOG_SHEET_NAME);
  }
  ensureHeaders_(sheet, INVOICE_EXTRACTOR_CONFIG.LOG_HEADERS);
  return sheet;
}

function ensureMonthSheet_(ss, monthTabName) {
  var sheet = ss.getSheetByName(monthTabName);
  if (!sheet) {
    sheet = ss.insertSheet(monthTabName);
  }
  ensureHeaders_(sheet, INVOICE_EXTRACTOR_CONFIG.MONTH_HEADERS);
  return sheet;
}

function ensureHeaders_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

function installPollingTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processPendingInvoices') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('processPendingInvoices')
    .timeBased()
    .everyMinutes(INVOICE_EXTRACTOR_CONFIG.TRIGGER_MINUTES)
    .create();
}

function getMasterSheet_(ss) {
  var sheet = ss.getSheetByName(INVOICE_EXTRACTOR_CONFIG.MASTER_SHEET_NAME);
  if (!sheet) {
    throw new Error('Missing Master sheet.');
  }
  return sheet;
}

function assertSelectedMasterSheet_(ss) {
  var sheet = ss.getActiveSheet();
  if (!sheet || sheet.getName() !== INVOICE_EXTRACTOR_CONFIG.MASTER_SHEET_NAME) {
    throw new Error('Select a row in the Master sheet first.');
  }
  return sheet;
}

function assertDataRow_(rowNumber) {
  if (rowNumber < 2) {
    throw new Error('Select a Master data row, not the header row.');
  }
}

function readMasterRow_(sheet, rowNumber) {
  var headerMap = getMasterHeaderMap_(sheet);
  assertRequiredMasterHeaders_(headerMap);
  var values = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
  return buildMasterRowFromValues_(values, headerMap, rowNumber);
}

function getMasterHeaderMap_(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return buildHeaderMapFromValues_(headers);
}

function buildHeaderMapFromValues_(headers) {
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var key = normalizeHeader_(headers[i]);
    if (key) map[key] = i;
  }
  return map;
}

function buildMasterRowFromValues_(values, headerMap, rowNumber) {
  return {
    rowNumber: rowNumber,
    date: getValueByHeader_(values, headerMap, 'Date'),
    transactionId: String(getValueByHeader_(values, headerMap, 'Transaction ID') || '').trim(),
    link: String(getValueByHeader_(values, headerMap, 'Link') || '').trim(),
    paymentStatus: String(getValueByHeader_(values, headerMap, 'Payment Status') || '').trim(),
    vatInvoiceId: String(getValueByHeader_(values, headerMap, 'VAT invoice ID') || '').trim()
  };
}

function getValueByHeader_(values, headerMap, header) {
  var index = headerMap[normalizeHeader_(header)];
  if (index === undefined) return '';
  return values[index];
}

function assertRequiredMasterHeaders_(headerMap) {
  var missing = [];
  for (var i = 0; i < INVOICE_EXTRACTOR_CONFIG.REQUIRED_MASTER_HEADERS.length; i++) {
    var header = INVOICE_EXTRACTOR_CONFIG.REQUIRED_MASTER_HEADERS[i];
    if (headerMap[normalizeHeader_(header)] === undefined) missing.push(header);
  }
  if (missing.length) {
    throw new Error('Master sheet is missing required headers: ' + missing.join(', '));
  }
}

function hasAnyInvoiceSignal_(row) {
  return !!(row.date || row.transactionId || row.link || row.paymentStatus || row.vatInvoiceId);
}

function parseDriveFileId(link) {
  var value = String(link || '').trim();
  if (!value) return '';

  var patterns = [
    /\/file\/d\/([A-Za-z0-9_-]+)/,
    /[?&]id=([A-Za-z0-9_-]+)/,
    /\/d\/([A-Za-z0-9_-]+)/,
    /\/uc\?export=download&id=([A-Za-z0-9_-]+)/
  ];
  for (var i = 0; i < patterns.length; i++) {
    var match = value.match(patterns[i]);
    if (match && match[1]) return match[1];
  }

  if (/^[A-Za-z0-9_-]{20,}$/.test(value)) return value;
  return '';
}

function getMonthTabName(dateValue) {
  var date = parseDateValue_(dateValue);
  if (!date) return 'Unknown_Month';
  return date.getFullYear() + '-' + pad2_(date.getMonth() + 1);
}

function parseDateValue_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'number' && isFinite(value)) {
    var spreadsheetEpoch = new Date(1899, 11, 30);
    return new Date(spreadsheetEpoch.getTime() + value * 24 * 60 * 60 * 1000);
  }

  var text = String(value || '').trim();
  if (!text) return null;

  var isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  }

  var slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slashMatch) {
    var year = Number(slashMatch[3]);
    if (year < 100) year += 2000;
    return new Date(year, Number(slashMatch[1]) - 1, Number(slashMatch[2]));
  }

  var parsed = new Date(text);
  if (!isNaN(parsed.getTime())) return parsed;
  return null;
}

function normalizeAmountValue_(value) {
  if (typeof value === 'number' && isFinite(value)) return Math.round(value);
  var text = String(value || '').trim();
  if (!text) return NaN;
  var negative = text.indexOf('-') !== -1 || /^\(.*\)$/.test(text);
  var digits = text.replace(/[^\d]/g, '');
  if (!digits) return NaN;
  var amount = Number(digits);
  return negative ? -amount : amount;
}

function parseGeminiJson_(text) {
  var cleaned = String(text || '').trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  var firstObject = cleaned.indexOf('{');
  var firstArray = cleaned.indexOf('[');
  var first = -1;
  if (firstObject === -1) first = firstArray;
  else if (firstArray === -1) first = firstObject;
  else first = Math.min(firstObject, firstArray);

  var lastObject = cleaned.lastIndexOf('}');
  var lastArray = cleaned.lastIndexOf(']');
  var last = Math.max(lastObject, lastArray);
  if (first >= 0 && last >= first) {
    cleaned = cleaned.slice(first, last + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error('Could not parse Gemini JSON response: ' + shorten_(cleaned, 500));
  }
}

function normalizeGeminiResult_(parsed) {
  var source = Array.isArray(parsed) ? parsed : parsed && parsed.campaigns;
  if (!Array.isArray(source)) {
    throw new Error('Gemini JSON response is missing campaigns array.');
  }

  var campaigns = [];
  for (var i = 0; i < source.length; i++) {
    var item = source[i] || {};
    var campaign = String(item.campaign || item.campaign_name || item.name || '').trim();
    if (!campaign) continue;

    var rawAmount = item.amount_chua_vat;
    if (rawAmount === undefined || rawAmount === null) rawAmount = item.amount_before_vat;
    if (rawAmount === undefined || rawAmount === null) rawAmount = item.amount;
    var amount = normalizeAmountValue_(rawAmount);
    if (!isFinite(amount)) {
      throw new Error('Invalid amount for campaign "' + campaign + '".');
    }

    campaigns.push({
      campaign: campaign,
      amountChuaVat: amount
    });
  }

  if (campaigns.length === 0) {
    throw new Error('Gemini returned no usable campaign rows.');
  }
  return campaigns;
}

function extractTextFromGeminiResponse_(responseJson) {
  var candidates = responseJson && responseJson.candidates ? responseJson.candidates : [];
  if (!candidates.length || !candidates[0].content || !candidates[0].content.parts) {
    throw new Error('Gemini response did not include text content.');
  }

  var parts = candidates[0].content.parts;
  var text = '';
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].text) text += parts[i].text;
  }
  if (!text) {
    throw new Error('Gemini response text was empty.');
  }
  return text;
}

function deleteRowsForInvoice_(sheet, invoiceId) {
  var key = normalizeKey_(invoiceId);
  if (!key || sheet.getLastRow() < 2) return 0;

  var values = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
  var deleted = 0;
  for (var i = values.length - 1; i >= 0; i--) {
    if (normalizeKey_(values[i][0]) === key) {
      sheet.deleteRow(i + 2);
      deleted++;
    }
  }
  return deleted;
}

function readLogMap_(logSheet) {
  var map = {};
  if (logSheet.getLastRow() < 2) return map;

  var values = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, INVOICE_EXTRACTOR_CONFIG.LOG_HEADERS.length).getValues();
  for (var i = 0; i < values.length; i++) {
    var rowValues = values[i];
    var key = normalizeKey_(rowValues[0] || rowValues[1] || rowValues[3]);
    if (!key) continue;
    map[key] = {
      rowNumber: i + 2,
      transactionId: String(rowValues[0] || '').trim(),
      vatInvoiceId: String(rowValues[1] || '').trim(),
      driveLink: String(rowValues[2] || '').trim(),
      driveFileId: String(rowValues[3] || '').trim(),
      status: String(rowValues[4] || '').trim(),
      retryCount: Number(rowValues[5] || 0),
      rowsWritten: Number(rowValues[6] || 0),
      error: String(rowValues[7] || '').trim(),
      processedAt: rowValues[8],
      masterRow: rowValues[9],
      monthTab: String(rowValues[10] || '').trim(),
      updatedAt: rowValues[11]
    };
  }
  return map;
}

function getLogEntry_(logSheet, key) {
  var map = readLogMap_(logSheet);
  return map[normalizeKey_(key)] || null;
}

function upsertLog_(logSheet, entry) {
  ensureHeaders_(logSheet, INVOICE_EXTRACTOR_CONFIG.LOG_HEADERS);
  var key = normalizeKey_(entry.transactionId || entry.vatInvoiceId || entry.driveFileId);
  if (!key) {
    throw new Error('Cannot write log entry without a transaction, invoice, or file key.');
  }

  var map = readLogMap_(logSheet);
  var rowNumber = map[key] ? map[key].rowNumber : logSheet.getLastRow() + 1;
  var values = [
    entry.transactionId || '',
    entry.vatInvoiceId || '',
    entry.driveLink || '',
    entry.driveFileId || '',
    entry.status || '',
    entry.retryCount || 0,
    entry.rowsWritten || 0,
    entry.error || '',
    entry.processedAt || '',
    entry.masterRow || '',
    entry.monthTab || '',
    new Date()
  ];
  logSheet.getRange(rowNumber, 1, 1, values.length).setValues([values]);
}

function deleteLogEntry_(logSheet, key) {
  var entry = getLogEntry_(logSheet, key);
  if (!entry) return 0;
  logSheet.deleteRow(entry.rowNumber);
  return 1;
}

function getLogKey_(row, fileId) {
  return row.transactionId || row.vatInvoiceId || fileId || ('MASTER_ROW_' + row.rowNumber);
}

function normalizeHeader_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeKey_(value) {
  return String(value || '').trim();
}

function pad2_(value) {
  return value < 10 ? '0' + value : String(value);
}

function formatDateForPrompt_(value) {
  var date = parseDateValue_(value);
  if (!date) return String(value || '');
  return date.getFullYear() + '-' + pad2_(date.getMonth() + 1) + '-' + pad2_(date.getDate());
}

function shorten_(value, limit) {
  var text = String(value || '');
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '...';
}

function hideSheetIfPossible_(sheet) {
  try {
    sheet.hideSheet();
  } catch (err) {
    console.log('Could not hide log sheet: ' + err.message);
  }
}

function notify_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (err) {
    console.log(message);
  }
}
