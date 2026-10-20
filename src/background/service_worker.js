/**
 * Screen Privacy Shield - Background Service Worker (Manifest V3)
 * v2.0 responsibilities:
 *  - Configuration sync + audit persistence + badge state
 *  - Screen-share detection (tabCapture) -> auto Present Mode
 *  - Keyboard commands (present mode, rescan)
 *  - PDF redirect to bundled pdf.js viewer
 *  - Offscreen document lifecycle for offline OCR/NER
 *  - Robust message handling (never leaves callers hanging)
 */

importScripts('audit_logger.js');

const logger = new ScreenShieldAuditLogger();
const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
let offscreenCreating = null;
let offscreenIdleTimer = null;
const OFFSCREEN_IDLE_MS = 60000;
const capturedTabIds = new Set();

// ---------------------------------------------------------------------------
// Configuration bootstrap
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[ScreenShield] Extension installed/updated:', details.reason);
  try {
    const resp = await fetch(chrome.runtime.getURL('config/default_rules.json'));
    const defaultRules = await resp.json();
    const res = await chrome.storage.local.get(['sps_config']);
    if (!res.sps_config) {
      await chrome.storage.local.set({ sps_config: defaultRules });
      logger.configure(defaultRules.settings);
    } else {
      // Merge new defaults (new categories/settings) into the stored config
      const over = res.sps_config;
      const merged = {
        ...defaultRules,
        ...over,
        settings: {
          ...(defaultRules.settings || {}),
          ...(over.settings || {}),
          presentMode: {
            ...((defaultRules.settings || {}).presentMode || {}),
            ...((over.settings || {}).presentMode || {})
          }
        },
        categories: {
          ...(defaultRules.categories || {}),
          ...(over.categories || {})
        },
        selectorRules: over.selectorRules || defaultRules.selectorRules || [],
        customRegexRules: over.customRegexRules || defaultRules.customRegexRules || []
      };
      await chrome.storage.local.set({ sps_config: merged });
      logger.configure(merged.settings);
    }
  } catch (err) {
    console.warn('[ScreenShield] Error during install config setup:', err);
  }

  // First-run onboarding: open the welcome card in Options so users learn
  // the hotkey, enable file:// PDF access, and see a live demo page.
  if (details.reason === 'install') {
    try {
      chrome.tabs.create({
        url: chrome.runtime.getURL('src/options/options.html#welcome')
      });
    } catch (e) {}
  }
});

chrome.storage.local.get(['sps_config'], (res) => {
  if (res && res.sps_config && res.sps_config.settings) {
    logger.configure(res.sps_config.settings);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sps_config) {
    const newConfig = changes.sps_config.newValue;
    if (newConfig && newConfig.settings) {
      logger.configure(newConfig.settings);
    }
  }
});

// ---------------------------------------------------------------------------
// Present Mode helpers
// ---------------------------------------------------------------------------

async function getConfig() {
  const res = await chrome.storage.local.get(['sps_config']);
  return res.sps_config || null;
}

async function setPresentMode(active, trigger) {
  const cfg = await getConfig();
  if (!cfg) return;
  cfg.settings = cfg.settings || {};
  cfg.settings.presentMode = cfg.settings.presentMode || {};
  cfg.settings.presentMode.active = !!active;
  // A manual toggle (hotkey/popup) means the user is overriding auto-capture
  // behavior for the current session. The hold is released when capture ends.
  cfg.settings.presentMode.manualHold =
    trigger === 'hotkey' || trigger === 'popup' || trigger === 'options';
  await chrome.storage.local.set({ sps_config: cfg });

  logger.logEvent({
    eventType: active ? 'PRESENT_MODE_ON' : 'PRESENT_MODE_OFF',
    category: 'SYSTEM',
    ruleId: 'present_mode',
    value: 'trigger:' + trigger
  });

  // Badge glyph as a global state hint
  try {
    chrome.action.setBadgeText({ text: active ? 'REC' : '' });
    if (active) chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
  } catch (e) {}

  broadcastToTabs({ action: 'PRESENT_MODE_CHANGED', active: !!active, trigger });
}

/**
 * Effective Present Mode for a given tab: explicit manual state OR an active
 * tab capture that isn't suppressed by a manual hold.
 */
function effectivePresentMode(cfg, tabId) {
  const pm = (cfg && cfg.settings && cfg.settings.presentMode) || {};
  const capturing = capturedTabIds.has(tabId);
  const active = !!pm.active ||
    (capturing && pm.autoOnCapture !== false && !pm.manualHold);
  return { active, capturing };
}

/** Resolve the tab relevant to a message sender (popup/options have none). */
async function resolveSenderTabId(sender) {
  if (sender && sender.tab && typeof sender.tab.id === 'number') {
    return sender.tab.id;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ? tab.id : -1;
  } catch (e) {
    return -1;
  }
}

function broadcastToTabs(msg) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      try {
        chrome.tabs.sendMessage(tab.id, msg, () => {
          if (chrome.runtime.lastError) {}
        });
      } catch (e) {}
    }
  });
}

function sendToTab(tabId, msg) {
  try {
    chrome.tabs.sendMessage(tabId, msg, () => {
      if (chrome.runtime.lastError) {}
    });
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Screen-share (tab capture) detection -> auto Present Mode
// ---------------------------------------------------------------------------

async function applyCaptureState(tabId, capturing) {
  if (capturing) capturedTabIds.add(tabId);
  else capturedTabIds.delete(tabId);

  const cfg = await getConfig();
  const pm = (cfg && cfg.settings && cfg.settings.presentMode) || {};
  if (!pm.autoOnCapture) return;

  if (capturing) {
    // A manual hold (user explicitly toggled PM on or off) wins over auto.
    if (pm.manualHold) return;
    sendToTab(tabId, { action: 'PRESENT_MODE_CHANGED', active: true, trigger: 'auto' });
    notifySharingStarted(tabId);
    logger.logEvent({
      eventType: 'CAPTURE_DETECTED', category: 'SYSTEM',
      ruleId: 'tab_capture', value: 'tab:' + tabId
    });
  } else if (pm.manualHold) {
    // Capture session ended: release the user's manual hold so the next
    // capture can auto-manage again. Whatever state the user chose stays.
    if (cfg && cfg.settings && cfg.settings.presentMode) {
      cfg.settings.presentMode.manualHold = false;
      try { await chrome.storage.local.set({ sps_config: cfg }); } catch (e) {}
    }
  } else {
    sendToTab(tabId, { action: 'PRESENT_MODE_CHANGED', active: false, trigger: 'auto' });
  }
}

if (chrome.tabCapture && chrome.tabCapture.onStatusChanged) {
  chrome.tabCapture.onStatusChanged.addListener((info) => {
    const capturing = info.status === 'active' || info.status === 'pending';
    applyCaptureState(info.tabId, capturing);
  });
}

// Backup poll: covers state changes missed while the service worker slept
chrome.alarms.create('sps-capture-poll', { periodInMinutes: 0.5 }); // 30s minimum
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'sps-capture-poll') return;
  try {
    if (!chrome.tabCapture || !chrome.tabCapture.getCapturedTabs) return;
    const captured = await chrome.tabCapture.getCapturedTabs();
    const liveIds = new Set(
      (captured || [])
        .filter(c => c.status === 'active' || c.status === 'pending')
        .map(c => c.tabId)
    );
    for (const id of liveIds) {
      if (!capturedTabIds.has(id)) applyCaptureState(id, true);
    }
    for (const id of capturedTabIds) {
      if (!liveIds.has(id)) applyCaptureState(id, false);
    }
  } catch (e) { /* tabCapture unavailable */ }
});

// ---------------------------------------------------------------------------
// Context menus (right-click privacy actions)
// ---------------------------------------------------------------------------

if (chrome.contextMenus) {
  chrome.runtime.onInstalled.addListener(() => {
    try {
      chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
          id: 'sps-blur-element',
          title: '🛡️ Always blur this element',
          contexts: ['all']
        });
        chrome.contextMenus.create({
          id: 'sps-blur-selection',
          title: '🛡️ Blur this selection',
          contexts: ['selection']
        });
        chrome.contextMenus.create({
          id: 'sps-never-blur',
          title: '🛡️ Never blur this value',
          contexts: ['all']
        });
      });
    } catch (e) {}
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab || typeof tab.id !== 'number') return;
    const map = {
      'sps-blur-element': 'SPS_CONTEXT_BLUR_ELEMENT',
      'sps-blur-selection': 'SPS_CONTEXT_BLUR_SELECTION',
      'sps-never-blur': 'SPS_CONTEXT_NEVER_BLUR'
    };
    const action = map[info.menuItemId];
    if (action) {
      sendToTab(tab.id, { action, selectionText: info.selectionText || '' });
    }
  });
}

// ---------------------------------------------------------------------------
// Meeting-site detection -> suggest Present Mode (covers OS-level sharing,
// which no capture API can see)
// ---------------------------------------------------------------------------

const MEETING_HOSTS = [
  'meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.live.com',
  'webex.com', 'app.slack.com', 'meet.jit.si', 'whereby.com',
  'gotomeet.me', 'meet.goto.com', 'discord.com'
];

function isMeetingHost(hostname) {
  return MEETING_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
}

const meetingSuggestedTabs = new Set();

if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const url = changeInfo.url;
    if (!url) return;
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { return; }
    if (!isMeetingHost(host) || meetingSuggestedTabs.has(tabId)) return;
    meetingSuggestedTabs.add(tabId);
    (async () => {
      const cfg = await getConfig();
      const pm = (cfg && cfg.settings && cfg.settings.presentMode) || {};
      if (pm.active || pm.autoOnCapture === false) return;
      sendToTab(tabId, { action: 'SUGGEST_PRESENT_MODE', host });
    })();
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    meetingSuggestedTabs.delete(tabId);
    notifiedCaptureTabs.delete(tabId);
  });
}

// ---------------------------------------------------------------------------
// Capture notification
// ---------------------------------------------------------------------------

const notifiedCaptureTabs = new Set();

function notifySharingStarted(tabId) {
  if (!chrome.notifications || notifiedCaptureTabs.has(tabId)) return;
  notifiedCaptureTabs.add(tabId);
  try {
    chrome.notifications.create('sps-capture-' + tabId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Screen Privacy Shield',
      message: 'This tab is being shared. Present Mode is ON - sensitive data is redacted.',
      priority: 1
    }, () => { if (chrome.runtime.lastError) {} });
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Keyboard commands
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-present-mode') {
    const cfg = await getConfig();
    const pm = (cfg && cfg.settings && cfg.settings.presentMode) || {};
    await setPresentMode(!pm.active, 'hotkey');
  } else if (command === 'rescan-page') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) sendToTab(tab.id, { action: 'RESCAN_PAGE' });
  }
});

// ---------------------------------------------------------------------------
// PDF redirect -> bundled pdf.js viewer
// ---------------------------------------------------------------------------

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // main frame only
  const url = details.url || '';
  if (!/\.pdf([?#].*)?$/i.test(url)) return;
  if (url.includes('sps_native=1')) return;
  if (url.startsWith(chrome.runtime.getURL(''))) return;

  const cfg = await getConfig();
  const pdfOn = cfg && cfg.settings && cfg.settings.pdfRedirect !== false;
  if (!pdfOn) return;

  const viewerUrl = chrome.runtime.getURL('src/pdf_viewer/pdf.html') +
    '?file=' + encodeURIComponent(url);
  try {
    chrome.tabs.update(details.tabId, { url: viewerUrl });
  } catch (e) {}
});

// ---------------------------------------------------------------------------
// Offscreen document lifecycle (OCR / NER inference)
// ---------------------------------------------------------------------------

async function ensureOffscreen() {
  if (offscreenCreating) return offscreenCreating;
  try {
    const has = await chrome.offscreen.hasDocument();
    if (!has) {
      offscreenCreating = chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS', 'BLOBS'],
        justification: 'Offline OCR/NER inference in isolated worker context'
      });
      await offscreenCreating;
      offscreenCreating = null;
    }
  } catch (e) {
    offscreenCreating = null;
    console.warn('[ScreenShield] Offscreen create failed:', e);
    throw e;
  }
}

function scheduleOffscreenTeardown() {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(async () => {
    try {
      const has = await chrome.offscreen.hasDocument();
      if (has) await chrome.offscreen.closeDocument();
    } catch (e) {}
  }, OFFSCREEN_IDLE_MS);
}

/**
 * Route a task to the offscreen document and relay its response.
 * Messages to offscreen docs go through runtime messaging with a
 * 'target: offscreen' envelope handled in offscreen.js.
 */
async function routeToOffscreen(msg, sendResponse) {
  try {
    await ensureOffscreen();
    if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);

    // createDocument resolves before offscreen.js has necessarily registered
    // its listener - retry on the "receiving end" race.
    let res = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        res = await chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const m = String(e && e.message || e);
        if (!/Receiving end|Could not establish/i.test(m)) throw e;
        await new Promise(r => setTimeout(r, 120));
      }
    }
    if (lastErr) throw lastErr;
    sendResponse(res || { status: 'EMPTY' });
    scheduleOffscreenTeardown();
  } catch (e) {
    sendResponse({ status: 'UNAVAILABLE', error: String(e) });
  }
}

// ---------------------------------------------------------------------------
// Message hub
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return false;

  // Messages marked for the offscreen document are handled THERE
  // (offscreen.js). The service worker must ignore them.
  if (msg.target === 'offscreen') return false;

  switch (msg.action) {
    case 'LOG_AUDIT_EVENT':
      logger.logEvent(msg.payload);
      sendResponse({ status: 'LOGGED' });
      return false;

    case 'UPDATE_BADGE_COUNT':
      if (sender && sender.tab && sender.tab.id) {
        const count = msg.count || 0;
        const text = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
        chrome.action.setBadgeText({ text, tabId: sender.tab.id });
        chrome.action.setBadgeBackgroundColor({ color: '#f43f5e', tabId: sender.tab.id });
      }
      sendResponse({ status: 'OK' });
      return false;

    case 'CLEAR_AUDIT_LOGS':
      ScreenShieldAuditLogger.clearLogs(() => {
        sendResponse({ status: 'CLEARED' });
      });
      return true; // async

    case 'GET_AUDIT_LOGS':
      chrome.storage.local.get(['sps_audit_logs'], (res) => {
        sendResponse({ logs: res.sps_audit_logs || [] });
      });
      return true; // async

    case 'GET_CAPTURE_STATUS':
      (async () => {
        const tabId = await resolveSenderTabId(sender);
        const cfg = await getConfig();
        const eff = effectivePresentMode(cfg, tabId);
        sendResponse({
          capturing: eff.capturing,
          capturedTabs: [...capturedTabIds]
        });
      })();
      return true; // async

    case 'SET_PRESENT_MODE':
      setPresentMode(!!msg.active, msg.trigger || 'popup').then(() => {
        sendResponse({ status: 'OK', active: !!msg.active });
      });
      return true; // async

    case 'GET_PRESENT_MODE':
      (async () => {
        const tabId = await resolveSenderTabId(sender);
        const cfg = await getConfig();
        sendResponse(effectivePresentMode(cfg, tabId));
      })();
      return true; // async

    case 'ADD_SELECTOR_RULE':
      (async () => {
        const cfg = await getConfig();
        if (!cfg || !msg.rule || !msg.rule.selector) {
          sendResponse({ status: 'INVALID' });
          return;
        }
        cfg.selectorRules = Array.isArray(cfg.selectorRules) ? cfg.selectorRules : [];
        cfg.selectorRules.push(msg.rule);
        await chrome.storage.local.set({ sps_config: cfg });
        sendResponse({ status: 'OK' });
      })();
      return true; // async - storage.onChanged propagates to all tabs

    case 'ADD_ALLOWLIST_HASH':
      (async () => {
        const cfg = await getConfig();
        if (!cfg || !msg.hash) {
          sendResponse({ status: 'INVALID' });
          return;
        }
        cfg.settings = cfg.settings || {};
        const list = Array.isArray(cfg.settings.allowlistedValueHashes)
          ? cfg.settings.allowlistedValueHashes : [];
        if (!list.includes(msg.hash)) list.push(msg.hash);
        cfg.settings.allowlistedValueHashes = list;
        await chrome.storage.local.set({ sps_config: cfg });
        sendResponse({ status: 'OK' });
      })();
      return true; // async

    case 'RUN_OCR_OFFSCREEN':
    case 'RUN_NER_OFFSCREEN':
      routeToOffscreen(msg, sendResponse);
      return true; // async

    case 'RUN_OCR_ON_URL':
      // Cross-origin <img>: the page can't read its pixels (tainted
      // canvas), so fetch the bytes here - host_permissions <all_urls>
      // covers it. Convert to a data URL and run the normal OCR path.
      (async () => {
        try {
          const url = msg.url || '';
          if (!/^https?:/i.test(url)) {
            sendResponse({ status: 'INVALID' });
            return;
          }
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 15000);
          const resp = await fetch(url, { signal: ctrl.signal });
          clearTimeout(timer);
          if (!resp.ok) throw new Error('fetch ' + resp.status);
          const blob = await resp.blob();
          if (blob.size > 10 * 1024 * 1024) throw new Error('image too large');
          if (blob.type && !blob.type.startsWith('image/')) {
            throw new Error('not an image');
          }
          if (/svg/i.test(blob.type)) throw new Error('svg not ocr-able');
          const dataUrl = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result);
            r.onerror = () => rej(r.error);
            r.readAsDataURL(blob);
          });
          routeToOffscreen({
            action: 'RUN_OCR_OFFSCREEN',
            imageDataUrl: dataUrl,
            langs: msg.langs
          }, sendResponse);
        } catch (e) {
          sendResponse({ status: 'ERROR', error: String(e) });
        }
      })();
      return true; // async

    case 'OFFSCREEN_TASK_DONE':
      scheduleOffscreenTeardown();
      sendResponse({ status: 'OK' });
      return false;

    default:
      // Always respond - never leave a caller's channel hanging
      sendResponse({ status: 'UNHANDLED', action: msg.action });
      return false;
  }
});
