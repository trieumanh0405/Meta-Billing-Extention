/* ============================================================
 * options.js — Settings persistence
 * ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('settingsForm');
  const saveStatus = document.getElementById('saveStatus');
  const MIN_DELAY_BETWEEN_ACCOUNTS = 20000;

  const fields = [
    'sheetId',
    'driveFolderId',
    'businessId',
    'metaToken',
    'defaultDateFrom',
    'delayBetweenAccounts',
  ];

  // Load saved settings
  chrome.storage.sync.get(fields.reduce((acc, f) => {
    acc[f] = '';
    return acc;
  }, {}), (data) => {
    fields.forEach(f => {
      const el = document.getElementById(f);
      if (!el) return;
      if (f === 'delayBetweenAccounts') {
        const savedDelay = Number(data[f]);
        el.value = Number.isFinite(savedDelay) && savedDelay >= MIN_DELAY_BETWEEN_ACCOUNTS
          ? String(savedDelay)
          : String(MIN_DELAY_BETWEEN_ACCOUNTS);
      } else if (data[f]) {
        el.value = data[f];
      }
    });
  });

  // Save settings
  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const values = {};
    fields.forEach(f => {
      const el = document.getElementById(f);
      if (el) values[f] = el.value.trim();
    });
    const delay = Number(values.delayBetweenAccounts);
    values.delayBetweenAccounts = String(
      Number.isFinite(delay) && delay >= MIN_DELAY_BETWEEN_ACCOUNTS
        ? delay
        : MIN_DELAY_BETWEEN_ACCOUNTS
    );

    // Validate required fields
    if (!values.sheetId) {
      showStatus('❌ Sheet ID is required', 'error');
      return;
    }
    if (!values.driveFolderId) {
      showStatus('❌ Drive Folder ID is required', 'error');
      return;
    }

    chrome.storage.sync.set(values, () => {
      showStatus('✅ Saved!', 'success');
    });
  });

  function showStatus(msg, type) {
    saveStatus.textContent = msg;
    saveStatus.className = `save-status ${type}`;
    setTimeout(() => {
      saveStatus.textContent = '';
    }, 3000);
  }
});
