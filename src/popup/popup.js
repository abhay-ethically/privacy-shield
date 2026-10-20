/**
 * Screen Privacy Shield - Popup Controller
 * Manages quick settings, current tab status, Present Mode, rescan triggers,
 * and the live "tab being shared" indicator.
 */

(function () {
  'use strict';

  let currentConfig = null;
  let activeTabId = null;

  document.addEventListener('DOMContentLoaded', async () => {
    await initTabInfo();
    loadConfig();
    initEventListeners();
    refreshShareStatus();
  });

  async function initTabInfo() {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0]) {
        activeTabId = tabs[0].id;
        try {
          const url = new URL(tabs[0].url);
          document.getElementById('siteHost').textContent = url.hostname;
        } catch (e) {
          document.getElementById('siteHost').textContent = 'Local / Unknown';
        }

        chrome.tabs.sendMessage(activeTabId, { action: 'GET_PAGE_STATS' }, (res) => {
          if (chrome.runtime.lastError) return;
          if (res && typeof res.activeOverlays === 'number') {
            document.getElementById('blurredCount').textContent = res.activeOverlays;
          }
        });
      }
    }

    // Lifetime protection count - computed locally from the audit log
    // (zero telemetry; the log is capped at 2,000 entries).
    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: 'GET_AUDIT_LOGS' }, (res) => {
        if (chrome.runtime.lastError || !res || !Array.isArray(res.logs)) return;
        const detections = res.logs.filter(l => l.eventType === 'DETECTION').length;
        const el = document.getElementById('totalProtected');
        if (el) {
          el.textContent = detections > 0
            ? `${detections.toLocaleString()} values protected on this device`
            : 'No detections yet';
        }
      });
    }
  }

  function refreshShareStatus() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    try {
      chrome.runtime.sendMessage({ action: 'GET_PRESENT_MODE' }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        const sharing = document.getElementById('sharingPill');
        if (res.capturing) sharing.classList.remove('hidden');
        if (typeof res.active === 'boolean') {
          document.getElementById('togglePresent').checked = res.active;
        }
      });
    } catch (e) {}
  }

  function loadConfig() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['sps_config'], (res) => {
        if (res && res.sps_config) {
          currentConfig = res.sps_config;
          syncToggles(currentConfig);
        }
      });
    }
  }

  function syncToggles(cfg) {
    const settings = cfg.settings || {};
    const enabled = settings.enabled !== false;
    const requireAlt = !!settings.requireAltKey;
    const pm = settings.presentMode || {};

    document.getElementById('toggleShield').checked = enabled;
    document.getElementById('toggleAltKey').checked = requireAlt;
    document.getElementById('togglePresent').checked = !!pm.active;

    updateStatusPill(enabled, !!pm.active);
  }

  function updateStatusPill(enabled, presentMode) {
    const pill = document.getElementById('statusPill');
    if (presentMode) {
      pill.className = 'status-pill present';
      pill.textContent = 'PRESENT';
    } else if (enabled) {
      pill.className = 'status-pill active';
      pill.textContent = 'ACTIVE';
    } else {
      pill.className = 'status-pill paused';
      pill.textContent = 'PAUSED';
    }
  }

  function initEventListeners() {
    document.getElementById('toggleShield').addEventListener('change', (e) => {
      if (!currentConfig) return;
      currentConfig.settings.enabled = e.target.checked;
      const pm = (currentConfig.settings.presentMode || {});
      updateStatusPill(e.target.checked, !!pm.active);
      saveAndBroadcast();
    });

    document.getElementById('toggleAltKey').addEventListener('change', (e) => {
      if (!currentConfig) return;
      currentConfig.settings.requireAltKey = e.target.checked;
      saveAndBroadcast();
    });

    // Present Mode -> service worker owns the broadcast + audit
    document.getElementById('togglePresent').addEventListener('change', (e) => {
      const active = e.target.checked;
      if (currentConfig) {
        currentConfig.settings.presentMode = {
          ...(currentConfig.settings.presentMode || {}),
          active,
          manualHold: true
        };
        saveAndBroadcast();
      }
      updateStatusPill(
        currentConfig ? currentConfig.settings.enabled !== false : true,
        active
      );
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({
            action: 'SET_PRESENT_MODE', active, trigger: 'popup'
          }, () => { if (chrome.runtime.lastError) {} });
        } catch (err) {}
      }
    });

    document.getElementById('rescanBtn').addEventListener('click', () => {
      if (activeTabId && chrome.tabs) {
        chrome.tabs.sendMessage(activeTabId, { action: 'RESCAN_PAGE' }, (res) => {
          if (chrome.runtime.lastError) return;
          if (res && typeof res.count === 'number') {
            document.getElementById('blurredCount').textContent = res.count;
          }
        });
      }
    });

    document.getElementById('openOptionsBtn').addEventListener('click', () => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      }
    });
  }

  function saveAndBroadcast() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ sps_config: currentConfig }, () => {
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
              } catch (err) {}
            });
          });
        }
      });
    }
  }
})();
