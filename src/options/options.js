/**
 * Screen Privacy Shield - Options & Audit Hub Controller
 * Manages configuration state, rules editing, storage persistence, and audit log analysis.
 */

(function () {
  'use strict';

  let currentConfig = null;
  let cachedLogs = [];

  // Tab titles and descriptions
  const TAB_INFO = {
    general: {
      title: 'General & Redaction Settings',
      desc: 'Configure real-time blur overlays, reveal timings, and modifier key behaviors.'
    },
    categories: {
      title: 'PII Detection Categories',
      desc: 'Toggle individual detection algorithms, checksum filters, and visual badges.'
    },
    rules: {
      title: 'Custom CSS & Regex Rules',
      desc: 'Define proprietary rules for internal tools, payroll tables, and custom tokens.'
    },
    domains: {
      title: 'Domain Controls & Allowlist',
      desc: 'Restrict the extension to internal domains or exempt specific services.'
    },
    models: {
      title: 'On-Device AI & OCR Modules',
      desc: 'Configure local Named Entity Recognition (Transformers.js) and OCR (Tesseract.js).'
    },
    audit: {
      title: 'Audit Trail & Compliance Log',
      desc: 'View real-time detection and deliberate reveal logs. Zero raw data retention.'
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initSliders();
    loadConfiguration();
    initAuditControls();
    initRulesControls();
    initWelcome();
  });

  // First-run welcome card (options.html#welcome opened on install)
  function initWelcome() {
    const card = document.getElementById('welcomeCard');
    if (!card) return;
    if (location.hash === '#welcome') {
      card.style.display = '';
    }
    const dismiss = document.getElementById('welcomeDismissBtn');
    if (dismiss) {
      dismiss.addEventListener('click', () => {
        card.style.display = 'none';
        history.replaceState(null, '', location.pathname);
      });
    }
  }

  // --- Tab Navigation ---
  function initTabs() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(btn => {
      btn.addEventListener('click', () => {
        navItems.forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

        btn.classList.add('active');
        const tabKey = btn.getAttribute('data-tab');
        const targetPane = document.getElementById(`tab-${tabKey}`);
        if (targetPane) targetPane.classList.add('active');

        // Update header
        const info = TAB_INFO[tabKey] || TAB_INFO.general;
        document.getElementById('pageTitle').textContent = info.title;
        document.getElementById('pageDescription').textContent = info.desc;

        if (tabKey === 'audit') {
          loadAuditLogs();
        }
      });
    });
  }

  // --- Range Sliders ---
  function initSliders() {
    const revealSlider = document.getElementById('setting_revealDelay');
    const revealVal = document.getElementById('revealDelayValue');
    if (revealSlider && revealVal) {
      revealSlider.addEventListener('input', (e) => {
        revealVal.textContent = `${e.target.value} ms`;
      });
    }

    const blurSlider = document.getElementById('setting_blurIntensity');
    const blurVal = document.getElementById('blurIntensityValue');
    if (blurSlider && blurVal) {
      blurSlider.addEventListener('input', (e) => {
        blurVal.textContent = `${e.target.value} px`;
      });
    }

    const maxOverlaySlider = document.getElementById('setting_maxOverlays');
    const maxOverlayVal = document.getElementById('maxOverlaysValue');
    if (maxOverlaySlider && maxOverlayVal) {
      maxOverlaySlider.addEventListener('input', (e) => {
        maxOverlayVal.textContent = `${e.target.value}`;
      });
    }

    // Allowlist add button
    const addAllowlistBtn = document.getElementById('addAllowlistBtn');
    if (addAllowlistBtn) {
      addAllowlistBtn.addEventListener('click', addAllowlistValue);
      document.getElementById('allowlistInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addAllowlistValue();
      });
    }

    // Save buttons
    document.getElementById('saveSettingsBtn').addEventListener('click', saveConfiguration);
    document.getElementById('saveTopBtn').addEventListener('click', saveConfiguration);
  }

  // --- Configuration Management ---

  // Deep-merge a stored config over bundled defaults so new v2 keys
  // (categories, presentMode, allowlist) always exist in the UI.
  function mergeConfigs(base, over) {
    over = over || {};
    base = base || {};
    return {
      ...base,
      ...over,
      settings: {
        ...(base.settings || {}),
        ...(over.settings || {}),
        presentMode: {
          ...((base.settings || {}).presentMode || {}),
          ...((over.settings || {}).presentMode || {})
        }
      },
      categories: { ...(base.categories || {}), ...(over.categories || {}) },
      selectorRules: over.selectorRules || base.selectorRules || [],
      customRegexRules: over.customRegexRules || base.customRegexRules || []
    };
  }

  function loadConfiguration() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      fetch(chrome.runtime.getURL('config/default_rules.json'))
        .then(r => r.json())
        .then(defaultCfg => {
          chrome.storage.local.get(['sps_config'], (res) => {
            currentConfig = mergeConfigs(defaultCfg, res && res.sps_config);
            populateForm(currentConfig);
          });
        })
        .catch(() => {
          chrome.storage.local.get(['sps_config'], (res) => {
            currentConfig = res.sps_config || null;
            populateForm(currentConfig);
          });
        });
    } else {
      // Fallback for preview in browser without chrome APIs
      fetch('../../config/default_rules.json')
        .then(r => r.json())
        .then(defaultCfg => {
          currentConfig = defaultCfg;
          populateForm(currentConfig);
        })
        .catch(() => {});
    }
  }

  function populateForm(cfg) {
    if (!cfg) return;
    const settings = cfg.settings || {};

    // General
    document.getElementById('setting_enabled').checked = settings.enabled !== false;
    document.getElementById('setting_revealDelay').value = settings.revealDelayMs || 250;
    document.getElementById('revealDelayValue').textContent = `${settings.revealDelayMs || 250} ms`;
    document.getElementById('setting_requireAltKey').checked = !!settings.requireAltKey;
    document.getElementById('setting_blurIntensity').value = settings.blurIntensity || 8;
    document.getElementById('blurIntensityValue').textContent = `${settings.blurIntensity || 8} px`;
    document.getElementById('setting_maxOverlays').value = settings.maxOverlays || 300;
    document.getElementById('maxOverlaysValue').textContent = `${settings.maxOverlays || 300}`;

    // Present Mode
    const pm = settings.presentMode || {};
    document.getElementById('setting_pmAutoCapture').checked = pm.autoOnCapture !== false;
    document.getElementById('setting_pmOpaque').checked = pm.opaque !== false;
    document.getElementById('setting_pmAllowReveal').checked = !!pm.allowRevealInPresentMode;
    document.getElementById('setting_pmWatermark').checked = pm.watermarkEnabled !== false;
    document.getElementById('setting_pmWatermarkText').value = pm.watermarkText || '';

    // PDF
    document.getElementById('setting_pdfRedirect').checked = settings.pdfRedirect !== false;

    // AI & OCR
    document.getElementById('setting_enableNer').checked = !!settings.enableNer;
    document.getElementById('setting_enableOcr').checked = !!settings.enableOcr;

    // Domains
    document.getElementById('setting_allowedDomains').value = (settings.allowedDomains || []).join('\n');
    document.getElementById('setting_blockedDomains').value = (settings.blockedDomains || []).join('\n');

    // Audit settings
    document.getElementById('setting_auditLoggingEnabled').checked = settings.auditLoggingEnabled !== false;
    document.getElementById('setting_remoteAuditEndpoint').value = settings.remoteAuditEndpoint || '';

    // Categories
    renderCategories(cfg.categories || {});

    // Rules
    renderSelectorRules(cfg.selectorRules || []);
    renderRegexRules(cfg.customRegexRules || []);
    renderAllowlist(settings.allowlistedValueHashes || []);
  }

  function renderCategories(categories) {
    const container = document.getElementById('categoriesList');
    container.innerHTML = '';

    for (const [catKey, catData] of Object.entries(categories)) {
      const card = document.createElement('div');
      card.className = 'category-card';

      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'label-title';
      title.textContent = catData.name || catKey;

      const badge = document.createElement('span');
      badge.className = 'cat-pill';
      badge.style.backgroundColor = catData.color || '#38bdf8';
      badge.textContent = catData.badge || catKey;

      info.appendChild(title);
      info.appendChild(badge);

      const switchLabel = document.createElement('label');
      switchLabel.className = 'switch';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = catData.enabled !== false;
      chk.dataset.category = catKey;
      chk.addEventListener('change', (e) => {
        if (currentConfig.categories[catKey]) {
          currentConfig.categories[catKey].enabled = e.target.checked;
        }
      });

      const slider = document.createElement('span');
      slider.className = 'slider';

      switchLabel.appendChild(chk);
      switchLabel.appendChild(slider);

      card.appendChild(info);
      card.appendChild(switchLabel);
      container.appendChild(card);
    }
  }

  // --- Rules Controls ---
  function initRulesControls() {
    document.getElementById('addSelectorBtn').addEventListener('click', () => {
      if (!currentConfig.selectorRules) currentConfig.selectorRules = [];
      currentConfig.selectorRules.push({
        id: 'rule_' + Date.now().toString(36),
        selector: '.confidential-field',
        label: 'Sensitive Element',
        category: 'CUSTOM_SELECTOR'
      });
      renderSelectorRules(currentConfig.selectorRules);
    });

    document.getElementById('addRegexBtn').addEventListener('click', () => {
      if (!currentConfig.customRegexRules) currentConfig.customRegexRules = [];
      currentConfig.customRegexRules.push({
        id: 'regex_' + Date.now().toString(36),
        name: 'Custom Pattern',
        pattern: '\\bEMP-\\d{6}\\b',
        badge: '🆔 EMP ID',
        color: '#ec4899',
        category: 'API_KEY'
      });
      renderRegexRules(currentConfig.customRegexRules);
    });
  }

  function renderSelectorRules(rules) {
    const container = document.getElementById('selectorRulesContainer');
    container.innerHTML = '';

    if (!rules || rules.length === 0) {
      container.innerHTML = '<div class="empty-state">No custom CSS selector rules defined.</div>';
      return;
    }

    rules.forEach((rule, idx) => {
      const item = document.createElement('div');
      item.className = 'rule-item';

      const selInput = document.createElement('input');
      selInput.type = 'text';
      selInput.className = 'rule-selector';
      selInput.value = rule.selector;
      selInput.placeholder = 'CSS Selector (e.g. td.salary, [data-pii])';
      selInput.addEventListener('input', (e) => { rule.selector = e.target.value; });

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'rule-label';
      labelInput.value = rule.label;
      labelInput.placeholder = 'Label Badge (e.g. Salary)';
      labelInput.addEventListener('input', (e) => { rule.label = e.target.value; });

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-sm';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => {
        rules.splice(idx, 1);
        renderSelectorRules(rules);
      });

      item.appendChild(selInput);
      item.appendChild(labelInput);
      item.appendChild(delBtn);
      container.appendChild(item);
    });
  }

  function renderRegexRules(rules) {
    const container = document.getElementById('regexRulesContainer');
    container.innerHTML = '';

    if (!rules || rules.length === 0) {
      container.innerHTML = '<div class="empty-state">No custom regex rules defined.</div>';
      return;
    }

    rules.forEach((rule, idx) => {
      const item = document.createElement('div');
      item.className = 'rule-item';

      const patInput = document.createElement('input');
      patInput.type = 'text';
      patInput.className = 'rule-selector';
      patInput.value = rule.pattern;
      patInput.placeholder = 'Regex pattern (e.g. \\bEMP-\\d{6}\\b)';
      patInput.addEventListener('input', (e) => { rule.pattern = e.target.value; });

      const badgeInput = document.createElement('input');
      badgeInput.type = 'text';
      badgeInput.className = 'rule-label';
      badgeInput.value = rule.badge;
      badgeInput.placeholder = 'Badge (e.g. 🆔 EMP ID)';
      badgeInput.addEventListener('input', (e) => { rule.badge = e.target.value; });

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-sm';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => {
        rules.splice(idx, 1);
        renderRegexRules(rules);
      });

      item.appendChild(patInput);
      item.appendChild(badgeInput);
      item.appendChild(delBtn);
      container.appendChild(item);
    });
  }

  // FNV-1a hash - must match hashString() in dom_scanner.js exactly,
  // since allowlist hashes are compared against scanned values.
  function fnvHash(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return ('0000000' + (hash >>> 0).toString(16)).slice(-8);
  }

  function renderAllowlist(hashes) {
    const container = document.getElementById('allowlistContainer');
    if (!container) return;
    container.innerHTML = '';

    if (!hashes || hashes.length === 0) {
      container.innerHTML = '<div class="empty-state">No allowlisted values.</div>';
      return;
    }

    hashes.forEach((h, idx) => {
      const item = document.createElement('div');
      item.className = 'rule-item';

      const hashSpan = document.createElement('span');
      hashSpan.className = 'rule-selector hash-display';
      hashSpan.textContent = `#${h}`;
      hashSpan.title = 'Hashed value - raw text is never stored';

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-sm';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => {
        hashes.splice(idx, 1);
        currentConfig.settings.allowlistedValueHashes = hashes;
        renderAllowlist(hashes);
      });

      item.appendChild(hashSpan);
      item.appendChild(delBtn);
      container.appendChild(item);
    });
  }

  function addAllowlistValue() {
    const input = document.getElementById('allowlistInput');
    const raw = (input.value || '').trim();
    if (!raw) return;
    if (!currentConfig.settings.allowlistedValueHashes) {
      currentConfig.settings.allowlistedValueHashes = [];
    }
    const h = fnvHash(raw);
    if (!currentConfig.settings.allowlistedValueHashes.includes(h)) {
      currentConfig.settings.allowlistedValueHashes.push(h);
    }
    input.value = '';
    renderAllowlist(currentConfig.settings.allowlistedValueHashes);
  }

  function saveConfiguration() {
    if (!currentConfig) return;

    // Gather settings
    const settings = currentConfig.settings || {};
    settings.enabled = document.getElementById('setting_enabled').checked;
    settings.revealDelayMs = parseInt(document.getElementById('setting_revealDelay').value, 10);
    settings.requireAltKey = document.getElementById('setting_requireAltKey').checked;
    settings.blurIntensity = parseInt(document.getElementById('setting_blurIntensity').value, 10);
    settings.maxOverlays = parseInt(document.getElementById('setting_maxOverlays').value, 10) || 300;

    settings.enableNer = document.getElementById('setting_enableNer').checked;
    settings.enableOcr = document.getElementById('setting_enableOcr').checked;

    settings.auditLoggingEnabled = document.getElementById('setting_auditLoggingEnabled').checked;
    settings.remoteAuditEndpoint = document.getElementById('setting_remoteAuditEndpoint').value.trim();

    settings.pdfRedirect = document.getElementById('setting_pdfRedirect').checked;

    // Present Mode (preserve active/manualHold flags from live state)
    const existingPm = settings.presentMode || {};
    settings.presentMode = {
      ...existingPm,
      autoOnCapture: document.getElementById('setting_pmAutoCapture').checked,
      opaque: document.getElementById('setting_pmOpaque').checked,
      allowRevealInPresentMode: document.getElementById('setting_pmAllowReveal').checked,
      watermarkEnabled: document.getElementById('setting_pmWatermark').checked,
      watermarkText: document.getElementById('setting_pmWatermarkText').value.trim()
    };

    settings.allowedDomains = document.getElementById('setting_allowedDomains').value
      .split('\n')
      .map(d => d.trim().toLowerCase())
      .filter(Boolean);

    settings.blockedDomains = document.getElementById('setting_blockedDomains').value
      .split('\n')
      .map(d => d.trim().toLowerCase())
      .filter(Boolean);

    currentConfig.settings = settings;

    // Persist to storage
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ sps_config: currentConfig }, () => {
        showSaveSuccess();

        // Broadcast to tabs
        if (chrome.tabs && chrome.tabs.query) {
          chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
              try {
                chrome.tabs.sendMessage(tab.id, {
                  action: 'SETTINGS_UPDATED',
                  config: currentConfig
                }, () => {
                  if (chrome.runtime.lastError) {}
                });
              } catch (e) {}
            });
          });
        }
      });
    } else {
      showSaveSuccess();
    }
  }

  function showSaveSuccess() {
    const indicator = document.getElementById('saveStatus');
    if (indicator) {
      indicator.textContent = '✓ Settings Saved';
      indicator.style.opacity = '1';
      setTimeout(() => {
        indicator.style.opacity = '0';
      }, 3000);
    }
  }

  // --- Audit Controls & Viewer ---
  function initAuditControls() {
    document.getElementById('refreshLogsBtn').addEventListener('click', loadAuditLogs);
    document.getElementById('exportCsvBtn').addEventListener('click', exportLogsCsv);
    document.getElementById('exportJsonBtn').addEventListener('click', exportLogsJson);
    document.getElementById('exportReportBtn').addEventListener('click', exportComplianceReport);
    document.getElementById('clearLogsBtn').addEventListener('click', clearLogs);

    document.getElementById('logSearchInput').addEventListener('input', filterAndRenderLogs);
    document.getElementById('logEventFilter').addEventListener('change', filterAndRenderLogs);
  }

  function loadAuditLogs() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['sps_audit_logs'], (res) => {
        cachedLogs = res.sps_audit_logs || [];
        filterAndRenderLogs();
      });
    } else {
      // Mock logs for preview
      cachedLogs = [
        {
          id: 'evt_demo_1',
          timestamp: Date.now() - 60000,
          isoTime: new Date(Date.now() - 60000).toISOString(),
          eventType: 'DETECTION',
          category: 'CREDIT_CARD',
          ruleId: 'CREDIT_CARD',
          fieldHash: 'a7c92f10b4885c39',
          url: 'https://internal-billing.corp/invoices',
          user: 'device_demo'
        },
        {
          id: 'evt_demo_2',
          timestamp: Date.now() - 25000,
          isoTime: new Date(Date.now() - 25000).toISOString(),
          eventType: 'REVEAL',
          category: 'CREDIT_CARD',
          ruleId: 'CREDIT_CARD',
          fieldHash: 'a7c92f10b4885c39',
          url: 'https://internal-billing.corp/invoices',
          user: 'device_demo'
        }
      ];
      filterAndRenderLogs();
    }
  }

  function filterAndRenderLogs() {
    const query = (document.getElementById('logSearchInput').value || '').toLowerCase();
    const typeFilter = document.getElementById('logEventFilter').value;

    const filtered = cachedLogs.filter(entry => {
      if (typeFilter !== 'ALL' && entry.eventType !== typeFilter) {
        return false;
      }
      if (query) {
        const str = `${entry.url} ${entry.category} ${entry.ruleId} ${entry.fieldHash} ${entry.eventType}`.toLowerCase();
        return str.includes(query);
      }
      return true;
    });

    document.getElementById('logCountBadge').textContent = `${filtered.length} of ${cachedLogs.length} events`;
    renderLogsTable(filtered);
  }

  function renderLogsTable(logs) {
    const tbody = document.getElementById('auditTableBody');
    tbody.innerHTML = '';

    if (!logs || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No audit events match your filter.</td></tr>';
      return;
    }

    logs.forEach(entry => {
      const tr = document.createElement('tr');

      // Time
      const timeTd = document.createElement('td');
      const d = new Date(entry.timestamp);
      timeTd.textContent = `${d.toLocaleTimeString()} (${d.toLocaleDateString()})`;
      tr.appendChild(timeTd);

      // Event Type
      const eventTd = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = `event-pill ${entry.eventType}`;
      pill.textContent = entry.eventType;
      eventTd.appendChild(pill);
      tr.appendChild(eventTd);

      // Category
      const catTd = document.createElement('td');
      catTd.textContent = entry.category;
      tr.appendChild(catTd);

      // Rule ID
      const ruleTd = document.createElement('td');
      ruleTd.textContent = entry.ruleId;
      tr.appendChild(ruleTd);

      // Field Hash
      const hashTd = document.createElement('td');
      hashTd.className = 'hash-cell';
      hashTd.textContent = (entry.fieldHash || '').substring(0, 16) + '...';
      hashTd.title = entry.fieldHash || '';
      tr.appendChild(hashTd);

      // URL
      const urlTd = document.createElement('td');
      urlTd.className = 'url-cell';
      urlTd.textContent = entry.url;
      urlTd.title = entry.url;
      tr.appendChild(urlTd);

      tbody.appendChild(tr);
    });
  }

  function clearLogs() {
    if (confirm('Are you sure you want to permanently clear the local audit log history?')) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ sps_audit_logs: [] }, () => {
          cachedLogs = [];
          filterAndRenderLogs();
        });
      } else {
        cachedLogs = [];
        filterAndRenderLogs();
      }
    }
  }

  function exportLogsCsv() {
    if (cachedLogs.length === 0) {
      alert('No audit logs to export.');
      return;
    }

    const headers = ['Event ID', 'Timestamp', 'ISO Time', 'Event Type', 'Category', 'Rule ID', 'SHA-256 Field Hash', 'Target URL', 'User'];
    const rows = cachedLogs.map(e => [
      `"${e.id}"`,
      e.timestamp,
      `"${e.isoTime}"`,
      `"${e.eventType}"`,
      `"${e.category}"`,
      `"${e.ruleId}"`,
      `"${e.fieldHash}"`,
      `"${e.url}"`,
      `"${e.user}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    downloadBlob(csvContent, 'text/csv', `screen_shield_audit_${Date.now()}.csv`);
  }

  function exportLogsJson() {
    if (cachedLogs.length === 0) {
      alert('No audit logs to export.');
      return;
    }

    const jsonContent = JSON.stringify(cachedLogs, null, 2);
    downloadBlob(jsonContent, 'application/json', `screen_shield_audit_${Date.now()}.json`);
  }

  /**
   * Summarized compliance report (Markdown): detection volume per
   * category/domain, reveal activity, and Present Mode usage - designed
   * for DPDP/enterprise audit trails. Contains only hashed fingerprints,
   * never raw values.
   */
  function exportComplianceReport() {
    if (cachedLogs.length === 0) {
      alert('No audit logs to report on.');
      return;
    }

    const byCategory = {};
    const byDomain = {};
    const byType = {};
    let first = Infinity, last = 0;
    for (const e of cachedLogs) {
      byType[e.eventType] = (byType[e.eventType] || 0) + 1;
      if (e.eventType === 'DETECTION') {
        byCategory[e.category] = (byCategory[e.category] || 0) + 1;
        const domain = (e.url || '').replace(/^https?:\/\//, '').split('/')[0] || '(local)';
        byDomain[domain] = (byDomain[domain] || 0) + 1;
      }
      if (e.timestamp < first) first = e.timestamp;
      if (e.timestamp > last) last = e.timestamp;
    }

    const fmtDate = t => new Date(t).toISOString();
    const table = (obj) =>
      Object.entries(obj).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `| ${k} | ${v} |`).join('\n');

    const report = [
      '# Screen Privacy Shield - Compliance Report',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Coverage window: ${fmtDate(first)} → ${fmtDate(last)}`,
      'Data policy: zero raw sensitive values - all fingerprints are SHA-256 hashes.',
      '',
      '## Summary',
      '',
      `| Metric | Count |`,
      `|---|---|`,
      `| Total events | ${cachedLogs.length} |`,
      `| Detections (values redacted) | ${byType.DETECTION || 0} |`,
      `| Deliberate reveals | ${byType.REVEAL || 0} |`,
      `| Re-blurs | ${byType.REBLUR || 0} |`,
      `| Present Mode activations | ${byType.PRESENT_MODE_ON || 0} |`,
      `| Tab captures detected | ${byType.CAPTURE_DETECTED || 0} |`,
      '',
      '## Detections by Category',
      '',
      '| Category | Count |',
      '|---|---|',
      table(byCategory) || '| (none) | 0 |',
      '',
      '## Detections by Domain',
      '',
      '| Domain | Count |',
      '|---|---|',
      table(byDomain) || '| (none) | 0 |',
      ''
    ].join('\n');

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    downloadBlob(report, 'text/markdown', `sps_compliance_report_${stamp}.md`);
  }

  function downloadBlob(content, mimeType, filename) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
})();
