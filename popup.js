/* ============================================================
 * popup.js — Popup UI logic
 * ============================================================ */

document.addEventListener('DOMContentLoaded', async () => {
  // ── Elements ───────────────────────────────────────────
  const setupWarning = document.getElementById('setupWarning');
  const openOptions = document.getElementById('openOptions');
  const modeTabs = document.querySelectorAll('.mode-tab');
  const singleMode = document.getElementById('singleMode');
  const multiMode = document.getElementById('multiMode');
  const scrapeCurrent = document.getElementById('scrapeCurrent');
  const startMulti = document.getElementById('startMulti');
  const scrapeControls = document.getElementById('scrapeControls');
  const pauseScrape = document.getElementById('pauseScrape');
  const resumeScrape = document.getElementById('resumeScrape');
  const stopScrape = document.getElementById('stopScrape');
  const refreshSession = document.getElementById('refreshSession');
  const dateFrom = document.getElementById('dateFrom');
  const dateTo = document.getElementById('dateTo');
  const accountIds = document.getElementById('accountIds');
  const autoDetect = document.getElementById('autoDetect');
  const progressSection = document.getElementById('progressSection');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const logSection = document.getElementById('logSection');
  const logOutput = document.getElementById('logOutput');
  const clearLog = document.getElementById('clearLog');

  // ── Init ───────────────────────────────────────────────

  // Set default dateTo to today
  dateTo.value = new Date().toISOString().split('T')[0];

  // Check config
  const config = await chrome.storage.sync.get(['sheetId', 'driveFolderId', 'defaultDateFrom']);
  if (!config.sheetId || !config.driveFolderId) {
    setupWarning.style.display = 'block';
  }
  if (config.defaultDateFrom) {
    dateFrom.value = config.defaultDateFrom;
  }

  // Restore last persisted multi-account job, if any.
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_PROGRESS' });
    if (status?.job) {
      progressSection.style.display = 'block';
      showLog();
      renderJob(status.job, status.isRunning);
      if (isJobActive(status.job, status.isRunning)) {
        pollProgress();
      }
    }
  } catch (err) {
    // Ignore startup restore errors; normal controls still work.
  }

  // Open options page
  openOptions.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // ── Mode Tabs ──────────────────────────────────────────

  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      modeTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const mode = tab.dataset.mode;
      singleMode.style.display = mode === 'single' ? 'block' : 'none';
      multiMode.style.display = mode === 'multi' ? 'block' : 'none';
    });
  });

  // ── Single Page Scrape ─────────────────────────────────

  scrapeCurrent.addEventListener('click', async () => {
    scrapeCurrent.disabled = true;
    scrapeCurrent.textContent = '⏳ Scraping...';
    progressSection.style.display = 'block';
    showLog();

    try {
      const response = await chrome.runtime.sendMessage({ type: 'SCRAPE_CURRENT_PAGE' });
      if (response?.error) {
        addLog(`❌ ${response.error}`);
        scrapeCurrent.disabled = false;
        scrapeCurrent.textContent = '▶ Scrape This Page';
        return;
      }

      // Show initial results
      if (response?.data) {
        const data = response.data;
        addLog(`✅ Found ${data.transactions.length} transactions`);
        addLog(`Account: ${data.accountName}`);
        data.transactions.forEach(tx => {
          addLog(`  ${tx.date} | ${tx.vatInvoiceId} | ${tx.amount} | DL: ${tx.downloadUrl ? '✅' : '❌'}`);
        });
      }

      // Poll for background processing logs (PDF upload + sheet write)
      addLog(`\n⏳ Processing PDFs + Sheet writes...`);
      pollSinglePageProgress();
    } catch (err) {
      addLog(`❌ ${err.message}`);
      scrapeCurrent.disabled = false;
      scrapeCurrent.textContent = '▶ Scrape This Page';
    }
  });

  // ── Multi Account Scrape ───────────────────────────────

  startMulti.addEventListener('click', async () => {
    const accounts = parseAccounts();
    if (accounts.length === 0 && !autoDetect.checked) {
      addLog('❌ No accounts specified and auto-detect is off');
      return;
    }

    startMulti.style.display = 'none';
    scrapeControls.style.display = 'flex';
    pauseScrape.style.display = 'inline-block';
    resumeScrape.style.display = 'none';
    progressSection.style.display = 'block';
    showLog();

    addLog(autoDetect.checked ? '🔍 Starting safe auto-detect for all accessible accounts...' : '▶ Starting manual multi-account scrape...');

    const response = await chrome.runtime.sendMessage({
      type: 'START_SCRAPE',
      accounts: [],
      accountInput: accountIds.value,
      autoDetect: autoDetect.checked,
      dateFrom: dateFrom.value,
      dateTo: dateTo.value,
    });

    if (response?.error) {
      addLog(`❌ ${response.error}`);
      startMulti.style.display = 'inline-block';
      scrapeControls.style.display = 'none';
      return;
    }

    // Start polling progress
    pollProgress();
  });

  stopScrape.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_SCRAPE' });
    stopScrape.textContent = '⏳ Stopping...';
  });

  pauseScrape.addEventListener('click', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'PAUSE_SCRAPE' });
    if (response?.error) {
      addLog(`❌ ${response.error}`);
      return;
    }
    pauseScrape.style.display = 'none';
    resumeScrape.style.display = 'inline-block';
    progressText.textContent = 'Pausing at next safe checkpoint...';
  });

  resumeScrape.addEventListener('click', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'RESUME_SCRAPE' });
    if (response?.error) {
      addLog(`❌ ${response.error}`);
      return;
    }
    pauseScrape.style.display = 'inline-block';
    resumeScrape.style.display = 'none';
    pollProgress();
  });

  refreshSession.addEventListener('click', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'REFRESH_SCRAPE_SESSION' });
    if (response?.error) {
      addLog(`❌ ${response.error}`);
      return;
    }
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    logOutput.textContent = '';
    progressFill.style.width = '0%';
    progressText.textContent = 'Ready';
    progressSection.style.display = 'none';
    logSection.style.display = 'none';
    startMulti.style.display = 'inline-block';
    scrapeControls.style.display = 'none';
    stopScrape.textContent = '⛔ Stop';
  });

  clearLog.addEventListener('click', () => {
    logOutput.textContent = '';
  });

  // ── Helpers ────────────────────────────────────────────

  function parseAccounts() {
    const raw = accountIds.value.trim();
    if (!raw) return [];
    return raw.split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(id => {
        // Clean up: remove "act_" prefix if present, extract number
        const clean = id.replace(/^act_/, '').replace(/\D/g, '');
        return { id: clean, name: id };
      });
  }

  let pollTimer = null;

  function pollProgress() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const status = await chrome.runtime.sendMessage({ type: 'GET_PROGRESS' });
      const job = status.job;

      if (job) {
        renderJob(job, status.isRunning);
      } else {
        if (status.total > 0) {
          const pct = Math.round((status.current / status.total) * 100);
          progressFill.style.width = `${pct}%`;
          progressText.textContent = `${status.current}/${status.total}: ${status.accountName}`;
        }

        if (status.log && status.log.length > 0) {
          logOutput.textContent = status.log.join('\n');
          logOutput.scrollTop = logOutput.scrollHeight;
        }
      }

      if (!isJobActive(job, status.isRunning)) {
        clearInterval(pollTimer);
        pollTimer = null;
        startMulti.style.display = 'inline-block';
        scrapeControls.style.display = 'none';
        stopScrape.textContent = '⛔ Stop';
      }
    }, 1500);
  }

  function renderJob(job, runtimeRunning) {
    const total = job.accounts?.length || 0;
    const completed = job.results?.length || 0;
    const activeIndex = Math.min((job.currentIndex || 0) + 1, total || 1);
    const activeAccount = total ? job.accounts[job.currentIndex] : null;

    let pct = 0;
    if (total > 0) {
      pct = Math.round((completed / total) * 100);
      if (runtimeRunning && completed < total) {
        pct = Math.max(pct, Math.round(((activeIndex - 1) / total) * 100));
      }
    } else if (job.status === 'detecting') {
      pct = 8;
    }

    progressFill.style.width = `${Math.min(100, pct)}%`;

    if (job.status === 'detecting') {
      progressText.textContent = 'Detecting accounts with spend...';
    } else if (job.status === 'done') {
      progressFill.style.width = '100%';
      progressText.textContent = `Done: ${job.totals.transactionsFound} tx, ${job.totals.pdfsUploaded} PDFs`;
    } else if (job.status === 'failed') {
      progressText.textContent = `Failed: ${job.error || 'unknown error'}`;
    } else if (job.status === 'completed_with_issues') {
      progressFill.style.width = '100%';
      progressText.textContent = `Finished with issues: ${job.totals.transactionsFound} tx, ${job.totals.accountsFailed} failed`;
    } else if (job.status === 'paused') {
      progressText.textContent = 'Paused';
    } else if (job.status === 'stopped' || job.status === 'stopping') {
      progressText.textContent = 'Stopping after current work...';
    } else if (job.status === 'interrupted') {
      progressText.textContent = 'Interrupted — start again from the last successful account';
    } else if (total > 0) {
      progressText.textContent = `${activeIndex}/${total}: ${activeAccount?.name || activeAccount?.id || 'Account'}`;
    }

    if (job.log && job.log.length > 0) {
      logOutput.textContent = job.log.join('\n');
      logOutput.scrollTop = logOutput.scrollHeight;
    }

    if (isJobActive(job, runtimeRunning)) {
      startMulti.style.display = 'none';
      scrapeControls.style.display = 'flex';
      pauseScrape.style.display = job.status === 'paused' ? 'none' : 'inline-block';
      resumeScrape.style.display = job.status === 'paused' ? 'inline-block' : 'none';
    }
  }

  function isJobActive(job, runtimeRunning) {
    if (!job) return runtimeRunning;
    return runtimeRunning || ['running', 'detecting', 'paused', 'stopping'].includes(job.status);
  }

  function showLog() {
    logSection.style.display = 'block';
  }

  function addLog(msg) {
    logOutput.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  let lastLogCount = 0;

  function pollSinglePageProgress() {
    const timer = setInterval(async () => {
      try {
        const status = await chrome.runtime.sendMessage({ type: 'GET_PROGRESS' });

        // Show new log entries from background
        if (status.log && status.log.length > lastLogCount) {
          const newEntries = status.log.slice(lastLogCount);
          newEntries.forEach(entry => {
            logOutput.textContent += entry + '\n';
          });
          logOutput.scrollTop = logOutput.scrollHeight;
          lastLogCount = status.log.length;
        }

        // Check if done
        if (!status.isRunning) {
          clearInterval(timer);
          scrapeCurrent.disabled = false;
          scrapeCurrent.textContent = '▶ Scrape This Page';
          progressText.textContent = 'Done!';
        }
      } catch (err) {
        clearInterval(timer);
        scrapeCurrent.disabled = false;
        scrapeCurrent.textContent = '▶ Scrape This Page';
      }
    }, 1000);
  }
});
