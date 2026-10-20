/**
 * Screen Privacy Shield - Content Script Main Orchestrator
 * Connects RegexEngine, OverlayManager, DomScanner, and HoverController.
 * Coordinates audit event dispatching, dynamic settings synchronization,
 * and Present Mode (screen-sharing) state.
 */

(function () {
  'use strict';

  // Prevent multiple injections (all_frames runs us per frame)
  if (window.__screenPrivacyShieldActive) return;
  window.__screenPrivacyShieldActive = true;

  let regexEngine = null;
  let hoverController = null;
  let overlayManager = null;
  let domScanner = null;
  let nerDetector = null;
  let ocrDetector = null;
  let config = null;
  let presentModeActive = false;

  // Complete built-in fallback configuration (always works, even offline/standalone)
  const DEFAULT_CONFIG = {
    version: "2.0.0",
    settings: {
      enabled: true,
      revealDelayMs: 250,
      requireAltKey: false,
      blurIntensity: 10,
      enableOcr: false,
      enableNer: false,
      auditLoggingEnabled: true,
      remoteAuditEndpoint: "",
      allowedDomains: [],
      blockedDomains: [],
      maxOverlays: 300,
      pdfRedirect: true,
      allowlistedValueHashes: [],
      presentMode: {
        autoOnCapture: true,
        active: false,
        manualHold: false,
        opaque: true,
        watermarkEnabled: true,
        watermarkText: "",
        allowRevealInPresentMode: false
      }
    },
    categories: {
      CREDIT_CARD: { name: "Credit Card", enabled: true, badge: "💳 CARD", color: "#f43f5e", requireChecksum: true },
      SSN: { name: "Social Security Number", enabled: true, badge: "🔒 SSN", color: "#ef4444", requireChecksum: false },
      EMAIL: { name: "Email Address", enabled: true, badge: "✉️ EMAIL", color: "#3b82f6", requireChecksum: false },
      PHONE: { name: "Phone Number", enabled: true, badge: "📞 PHONE", color: "#10b981", requireChecksum: false },
      API_KEY: { name: "API Key / Secret Token", enabled: true, badge: "🔑 KEY", color: "#f59e0b", requireChecksum: false },
      JWT: { name: "JSON Web Token", enabled: true, badge: "🛡️ JWT", color: "#8b5cf6", requireChecksum: false },
      IBAN: { name: "Bank Account (IBAN)", enabled: true, badge: "🏦 IBAN", color: "#06b6d4", requireChecksum: true },
      PRIVATE_KEY: { name: "Private Key Block", enabled: true, badge: "🚨 PRIV KEY", color: "#dc2626", requireChecksum: false },
      CONNECTION_STRING: { name: "Connection String / Cred URL", enabled: true, badge: "🗄️ CONN", color: "#be185d", requireChecksum: false },
      GENERIC_SECRET: { name: "Secret Assignment", enabled: true, badge: "🔐 SECRET", color: "#9333ea", requireChecksum: false },
      AADHAAR: { name: "Aadhaar Number", enabled: true, badge: "🪪 AADHAAR", color: "#ea580c", requireChecksum: true },
      PAN: { name: "PAN Card", enabled: true, badge: "🪪 PAN", color: "#d97706", requireChecksum: false },
      UPI: { name: "UPI ID", enabled: true, badge: "💸 UPI", color: "#059669", requireChecksum: false },
      IFSC: { name: "Bank IFSC Code", enabled: true, badge: "🏦 IFSC", color: "#0891b2", requireChecksum: false },
      PASSPORT: { name: "Passport Number", enabled: true, badge: "🛂 PASSPORT", color: "#7c3aed", requireChecksum: false },
      GSTIN: { name: "GSTIN (India)", enabled: true, badge: "🧾 GSTIN", color: "#c2410c", requireChecksum: true },
      VEHICLE_REG: { name: "Vehicle Registration (India)", enabled: true, badge: "🚗 VEHICLE", color: "#0369a1", requireChecksum: false },
      DRIVING_LICENSE: { name: "Driving Licence (India)", enabled: true, badge: "🪪 DL", color: "#9333ea", requireChecksum: false },
      VOTER_ID: { name: "Voter ID / EPIC (India)", enabled: true, badge: "🗳️ VOTER ID", color: "#15803d", requireChecksum: false },
      ROUTING: { name: "Bank Routing (ABA)", enabled: true, badge: "🏦 ROUTING", color: "#0d9488", requireChecksum: true },
      ENTROPY: { name: "High-Entropy String (experimental)", enabled: false, badge: "⚡ ENTROPY", color: "#64748b", requireChecksum: false },
      CUSTOM_SELECTOR: { name: "CSS Selector Rules", enabled: true, badge: "🎯 SELECTOR", color: "#ec4899", requireChecksum: false },
      NER_ENTITY: { name: "Unstructured NER Entity", enabled: true, badge: "🧠 NER", color: "#a855f7", requireChecksum: false },
      OCR_TEXT: { name: "OCR Detected Text", enabled: true, badge: "📷 OCR", color: "#14b8a6", requireChecksum: false }
    },
    selectorRules: [
      { id: "rule_salary", selector: ".confidential-salary, [data-pii=\"salary\"]", label: "Salary Data", category: "CUSTOM_SELECTOR" },
      { id: "rule_medical", selector: ".patient-diagnosis, [data-pii=\"medical\"]", label: "Medical Record", category: "CUSTOM_SELECTOR" },
      { id: "rule_account", selector: "td.account-number, [data-pii=\"account\"]", label: "Internal Account", category: "CUSTOM_SELECTOR" },
      { id: "rule_pii_data", selector: "[data-pii]", label: "Confidential PII", category: "CUSTOM_SELECTOR" }
    ],
    customRegexRules: []
  };

  // Embedded CSS for the Shadow DOM (mirrors overlay_styles.css)
  const OVERLAY_CSS = `
:host {
  all: initial;
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  min-height: 100%;
  pointer-events: none;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #ffffff;
  box-sizing: border-box;
}
*, *::before, *::after { box-sizing: inherit; }
.sps-blur-overlay {
  position: absolute;
  top: 0;
  left: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  cursor: pointer;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--sps-accent-soft, rgba(148, 163, 184, 0.4));
  background: rgba(255, 255, 255, 0.06);
  backdrop-filter: __SPS_BLUR__ saturate(160%);
  -webkit-backdrop-filter: __SPS_BLUR__ saturate(160%);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.20),
              inset 0 1px 0 rgba(255, 255, 255, 0.10);
  transition: opacity 0.16s ease,
              border-color 0.15s ease,
              background-color 0.15s ease,
              box-shadow 0.15s ease;
  animation: sps-overlay-in 0.18s ease-out;
  user-select: none;
  -webkit-user-select: none;
}
.sps-blur-overlay.sps-leaf-mask {
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  box-shadow: none;
}
:host(.sps-hit-off),
:host(.sps-hit-off) * {
  pointer-events: none !important;
}
@keyframes sps-overlay-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.sps-blur-overlay.sps-fixed {
  position: fixed;
}
.sps-blur-overlay:hover {
  border-color: var(--sps-accent, rgba(226, 232, 240, 0.7));
  background-color: rgba(255, 255, 255, 0.10);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
}
.sps-blur-overlay.sps-revealed {
  opacity: 0 !important;
  pointer-events: auto !important;
}
.sps-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px 2px 6px;
  font-size: 8.5px;
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  white-space: nowrap;
  border-radius: 999px;
  color: #f1f5f9;
  background: rgba(3, 7, 18, 0.80);
  border: 1px solid var(--sps-accent-soft, rgba(148, 163, 184, 0.45));
  pointer-events: none;
}
.sps-badge::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--sps-accent, #94a3b8);
  flex-shrink: 0;
}
.sps-compact .sps-badge-text { display: none; }
.sps-compact .sps-badge { padding: 2px; gap: 0; }
.sps-shimmer {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  width: 0%;
  background: linear-gradient(90deg, #38bdf8, #818cf8);
  transition: width linear;
  pointer-events: none;
}
.sps-blur-overlay.sps-arming .sps-shimmer { width: 100%; }
.sps-tooltip {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%) translateY(-6px);
  padding: 4px 8px;
  background: rgba(15, 23, 42, 0.95);
  color: #f8fafc;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 5px;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  opacity: 0;
  transition: opacity 0.15s ease, transform 0.15s ease;
  z-index: 10;
}
.sps-tooltip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border-width: 4px;
  border-style: solid;
  border-color: rgba(15, 23, 42, 0.95) transparent transparent transparent;
}
.sps-blur-overlay:hover .sps-tooltip.sps-visible {
  opacity: 1;
  transform: translateX(-50%) translateY(-8px);
}
:host(.sps-present) .sps-blur-overlay {
  background: #0b1120;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  border: 1px solid rgba(56, 189, 248, 0.5);
  box-shadow: 0 0 0 1px rgba(0,0,0,0.6), 0 2px 10px rgba(0, 0, 0, 0.6);
  cursor: default;
}
:host(.sps-present) .sps-blur-overlay::after {
  content: '████████';
  color: #334155;
  font-size: 11px;
  letter-spacing: 2px;
  overflow: hidden;
  white-space: nowrap;
  max-width: 100%;
}
:host(.sps-present) .sps-blur-overlay.sps-compact::after {
  content: '██';
  font-size: 9px;
}
:host(.sps-present) .sps-shimmer,
:host(.sps-present) .sps-tooltip {
  display: none !important;
}
:host(.sps-present) .sps-badge {
  position: absolute;
  top: 2px;
  left: 4px;
  font-size: 7.5px;
  padding: 1px 5px 1px 4px;
  z-index: 2;
}
:host(.sps-locked) .sps-blur-overlay.sps-revealed,
:host(.sps-locked) .sps-blur-overlay.sps-arming {
  opacity: 1 !important;
}
.sps-ribbon {
  position: fixed;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  display: none;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  background: linear-gradient(135deg, #7f1d1d, #b91c1c);
  color: #fff;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  box-shadow: 0 4px 24px rgba(185, 28, 28, 0.55), 0 0 0 2px rgba(0,0,0,0.4);
  pointer-events: none;
  z-index: 2147483647;
  animation: sps-ribbon-pulse 2s ease-in-out infinite;
}
@keyframes sps-ribbon-pulse {
  0%, 100% { box-shadow: 0 4px 24px rgba(185, 28, 28, 0.55), 0 0 0 2px rgba(0,0,0,0.4); }
  50% { box-shadow: 0 4px 30px rgba(239, 68, 68, 0.8), 0 0 0 3px rgba(185,28,28,0.5); }
}
.sps-watermark {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  display: none;
  pointer-events: none;
  z-index: 2147483646;
  opacity: 0.07;
  background-repeat: repeat;
}
.sps-suggest {
  position: fixed;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 480px;
  padding: 10px 14px;
  background: rgba(15, 23, 42, 0.97);
  color: #f1f5f9;
  font-size: 12.5px;
  font-weight: 600;
  border-radius: 12px;
  border: 1px solid rgba(56, 189, 248, 0.45);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55);
  pointer-events: auto;
  z-index: 2147483647;
  animation: sps-toast-in 0.25s ease-out;
}
.sps-suggest-btn {
  border: none;
  border-radius: 7px;
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}
.sps-suggest-yes { background: #b91c1c; color: #fff; }
.sps-suggest-yes:hover { background: #dc2626; }
.sps-suggest-no { background: rgba(255,255,255,0.12); color: #e2e8f0; }
.sps-suggest-no:hover { background: rgba(255,255,255,0.2); }
.sps-notice {
  position: fixed;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 16px;
  background: rgba(6, 78, 59, 0.95);
  color: #d1fae5;
  font-size: 12px;
  font-weight: 700;
  border-radius: 999px;
  border: 1px solid rgba(52, 211, 153, 0.4);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  z-index: 2147483647;
  animation: sps-toast-in 0.2s ease-out;
}
@keyframes sps-toast-in {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}
.sps-overflow-badge {
  position: fixed;
  bottom: 14px;
  right: 14px;
  display: none;
  padding: 6px 12px;
  background: rgba(15, 23, 42, 0.92);
  color: #f8fafc;
  font-size: 11px;
  font-weight: 700;
  border-radius: 8px;
  border: 1px solid rgba(56, 189, 248, 0.4);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
  pointer-events: none;
  z-index: 2147483647;
}
`;

  /**
   * Safe message dispatcher to background service worker
   */
  function sendAuditLog(eventType, details) {
    // Skip the message entirely when audit logging is disabled
    if (config && config.settings && config.settings.auditLoggingEnabled === false) return;
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          action: 'LOG_AUDIT_EVENT',
          payload: {
            eventType,
            url: window.location.href,
            origin: window.location.origin,
            title: document.title,
            timestamp: Date.now(),
            ...details
          }
        }, () => {
          if (chrome.runtime.lastError) {}
        });
      } catch (err) {}
    }
  }

  /**
   * Check if the current domain is allowed or blocked
   */
  function isDomainAllowed(settings) {
    if (!settings || settings.enabled === false) return false;

    const hostname = window.location.hostname;
    if (!hostname) return true; // file:// / about:blank / sandboxed frames

    if (Array.isArray(settings.blockedDomains) && settings.blockedDomains.length > 0) {
      if (settings.blockedDomains.some(d => d && hostname.includes(d))) {
        return false;
      }
    }

    if (Array.isArray(settings.allowedDomains) && settings.allowedDomains.length > 0) {
      return settings.allowedDomains.some(d => d && hostname.includes(d));
    }

    return true;
  }

  // Two independent PM sources: manual (global config / hotkey / popup)
  // and per-tab auto capture detection. Effective state mirrors the
  // service worker's effectivePresentMode() exactly.
  let manualPresent = false;
  let capturePresent = false;

  function effectivePresent() {
    const pm = (config && config.settings && config.settings.presentMode) || {};
    return manualPresent ||
      (capturePresent && pm.autoOnCapture !== false && !pm.manualHold);
  }

  /**
   * Apply present-mode visual state to all active modules.
   * trigger 'auto' updates the capture component; anything else updates
   * the manual component (init, hotkey, popup, settings sync).
   */
  function applyPresentMode(active, trigger) {
    if (trigger === 'auto') {
      capturePresent = !!active;
    } else {
      manualPresent = !!active;
    }
    presentModeActive = effectivePresent();
    if (overlayManager) {
      const pm = (config && config.settings && config.settings.presentMode) || {};
      overlayManager.setPresentMode(presentModeActive, {
        opaque: pm.opaque !== false,
        watermarkText: pm.watermarkText,
        watermarkEnabled: pm.watermarkEnabled !== false,
        allowReveal: pm.allowRevealInPresentMode === true
      });
    }
  }

  // Fingerprint of the last config that actually required a page rescan.
  // Present-mode state changes (active/manualHold) are cosmetic for the
  // scanner - skipping them avoids a full clear+rescan flicker mid-share.
  let lastScanFingerprint = '';
  let pendingRescan = false;

  /**
   * Initialize or update extension modules
   */
  function initModules(loadedConfig) {
    // Merge with default config to ensure complete coverage
    config = {
      ...DEFAULT_CONFIG,
      ...loadedConfig,
      settings: { ...DEFAULT_CONFIG.settings, ...(loadedConfig?.settings || {}) },
      categories: { ...DEFAULT_CONFIG.categories, ...(loadedConfig?.categories || {}) },
      selectorRules: loadedConfig?.selectorRules || DEFAULT_CONFIG.selectorRules,
      customRegexRules: loadedConfig?.customRegexRules || DEFAULT_CONFIG.customRegexRules
    };
    // Deep-merge nested presentMode
    config.settings.presentMode = {
      ...DEFAULT_CONFIG.settings.presentMode,
      ...(loadedConfig?.settings?.presentMode || {})
    };

    const settings = config.settings || {};
    const pm = settings.presentMode || {};
    const allowed = isDomainAllowed(settings);
    const wasInitialized = !!domScanner;

    // When disabled/blocked: clear overlays AND stop the scanner so no
    // new overlays can be created by subsequent mutations.
    if (domScanner) domScanner.setEnabled(allowed);
    if (nerDetector) nerDetector.setEnabled(allowed && !!settings.enableNer);
    if (ocrDetector) ocrDetector.setEnabled(allowed && !!settings.enableOcr);

    if (!allowed) {
      if (overlayManager) overlayManager.clearAll();
      pendingRescan = true; // must rebuild coverage once re-enabled
      return;
    }

    // Does anything that affects detection results actually differ?
    // blurIntensity is cosmetic (applied live via setBlurIntensity) -
    // exclude it like PM state so it doesn't trigger a full rescan.
    const pmFp = { ...config.settings.presentMode };
    delete pmFp.active;
    delete pmFp.manualHold;
    const settingsFp = { ...config.settings, presentMode: pmFp };
    delete settingsFp.blurIntensity;
    const fingerprint = JSON.stringify({
      s: settingsFp,
      c: config.categories,
      sr: config.selectorRules,
      cr: config.customRegexRules
    });
    const needRescan = !wasInitialized || pendingRescan ||
      fingerprint !== lastScanFingerprint;
    lastScanFingerprint = fingerprint;
    pendingRescan = false;

    // Regex Engine
    if (!regexEngine && window.ScreenShieldRegexEngine) {
      regexEngine = new window.ScreenShieldRegexEngine();
    }
    if (regexEngine) {
      regexEngine.configure(config.categories, config.customRegexRules);
    }

    // Hover Controller
    if (!hoverController && window.ScreenShieldHoverController) {
      hoverController = new window.ScreenShieldHoverController({
        revealDelayMs: settings.revealDelayMs || 250,
        requireAltKey: !!settings.requireAltKey,
        onReveal: (meta) => {
          sendAuditLog('REVEAL', {
            category: meta.category, ruleId: meta.ruleId, nodeHash: meta.nodeHash
          });
        },
        onReblur: (meta) => {
          sendAuditLog('REBLUR', { category: meta.category, ruleId: meta.ruleId });
        }
      });
    } else if (hoverController) {
      hoverController.updateSettings({
        revealDelayMs: settings.revealDelayMs,
        requireAltKey: settings.requireAltKey
      });
    }

    // Overlay Manager
    if (!overlayManager && window.ScreenShieldOverlayManager) {
      overlayManager = new window.ScreenShieldOverlayManager({
        hoverController: hoverController,
        blurIntensity: settings.blurIntensity || 8,
        maxOverlays: settings.maxOverlays || 300,
        watermarkText: pm.watermarkText || '',
        // When an ELEMENT overlay is removed, its subtree was never
        // deep-scanned (descent is skipped while covered) - rescan it.
        onElementUnmasked: (el) => {
          if (domScanner) domScanner.enqueueSubtree(el);
        }
      });
      overlayManager.injectStyles(OVERLAY_CSS);
      window.__spsOverlayManager = overlayManager;
      // Let the hover controller re-blur revealed overlays on present-mode entry
      if (hoverController) hoverController.overlayManager = overlayManager;
    }
    // Live blur-strength updates (Options slider) - cosmetic, no rescan
    if (overlayManager && overlayManager.setBlurIntensity) {
      overlayManager.setBlurIntensity(settings.blurIntensity || 8);
    }

    // NER Detector
    if (!nerDetector && window.ScreenShieldNerDetector) {
      nerDetector = new window.ScreenShieldNerDetector({
        overlayManager: overlayManager,
        enabled: !!settings.enableNer,
        onDetection: (meta) => {
          sendAuditLog('DETECTION', meta);
          notifyActiveCount();
        }
      });
    } else if (nerDetector) {
      nerDetector.setEnabled(allowed && !!settings.enableNer);
    }

    // OCR Detector
    if (!ocrDetector && window.ScreenShieldOcrDetector) {
      ocrDetector = new window.ScreenShieldOcrDetector({
        regexEngine: regexEngine,
        overlayManager: overlayManager,
        enabled: !!settings.enableOcr,
        onDetection: (meta) => {
          sendAuditLog('DETECTION', meta);
          notifyActiveCount();
        }
      });
    } else if (ocrDetector) {
      ocrDetector.setEnabled(allowed && !!settings.enableOcr);
    }
    window.__spsOcrDetector = ocrDetector;

    // DOM Scanner
    if (!domScanner && window.ScreenShieldDomScanner) {
      domScanner = new window.ScreenShieldDomScanner({
        regexEngine: regexEngine,
        overlayManager: overlayManager,
        nerDetector: nerDetector,
        ocrDetector: ocrDetector,
        enabled: allowed,
        selectorRules: config.selectorRules || [],
        allowlistedHashes: new Set(settings.allowlistedValueHashes || []),
        onDetection: (meta) => {
          sendAuditLog('DETECTION', {
            category: meta.category, ruleId: meta.ruleId, badge: meta.badge
          });
          notifyActiveCount();
        }
      });
      window.__spsDomScanner = domScanner;
    } else if (domScanner) {
      domScanner.updateSelectorRules(config.selectorRules || []);
      if (domScanner.updateAllowlist) {
        domScanner.updateAllowlist(settings.allowlistedValueHashes || []);
      }
    }

    // Apply stored present-mode state
    applyPresentMode(!!pm.active, 'init');

    // On re-init with a detection-relevant change: nuke overlays AND dedup
    // caches so the rescan rebuilds coverage from scratch with the new
    // rule set. Purely cosmetic changes (e.g. toggling Present Mode) skip
    // this entirely - overlays stay in place and just restyle.
    if (needRescan && wasInitialized && overlayManager && domScanner) {
      overlayManager.clearAll();
      domScanner.resetDedup();
    }

    // Full scan (incremental machinery handles subsequent changes).
    // Skipped when nothing detection-relevant changed.
    const runFullScan = () => {
      if (!needRescan) return;
      if (domScanner) {
        domScanner.scan();
      }
      if (ocrDetector && ocrDetector.enabled) {
        ocrDetector.scanMediaElements();
      }
      notifyActiveCount();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', runFullScan, { once: true });
    } else {
      runFullScan();
    }
    // Re-sync positions after webfonts/stylesheets settle (cheap - no re-scan)
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (overlayManager) overlayManager.requestSync();
      });
    }
  }

  let badgeNotifyTimer = null;
  function notifyActiveCount() {
    // Throttle: one badge message per 400ms max regardless of detection volume
    if (badgeNotifyTimer) return;
    badgeNotifyTimer = setTimeout(() => {
      badgeNotifyTimer = null;
      sendBadgeCount();
    }, 400);
  }

  function sendBadgeCount() {
    if (overlayManager && typeof chrome !== 'undefined' &&
        chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          action: 'UPDATE_BADGE_COUNT',
          count: overlayManager.getActiveCount()
        }, () => {
          if (chrome.runtime.lastError) {}
        });
      } catch (e) {}
    }
  }

  /**
   * Load stored config or fetch bundled default
   */
  function loadConfiguration() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['sps_config'], (res) => {
        if (res && res.sps_config) {
          initModules(res.sps_config);
        } else {
          initModules(DEFAULT_CONFIG);
          try {
            chrome.storage.local.set({ sps_config: DEFAULT_CONFIG });
          } catch (e) {}
        }
      });
    } else {
      // Standalone preview / non-extension context (e.g. pdf viewer page)
      initModules(DEFAULT_CONFIG);
    }
  }

  // ---------------------------------------------------------------
  // Right-click context-menu actions (forwarded from service worker)
  // ---------------------------------------------------------------

  let lastContextEl = null;
  document.addEventListener('contextmenu', (e) => {
    lastContextEl = e.target;
    // Right-clicking a chip retargets to our shadow host; resolve the
    // real element under the cursor so context-menu rules apply to the
    // page element, not to the overlay container.
    if (overlayManager && overlayManager.isOwnElement &&
        overlayManager.isOwnElement(lastContextEl)) {
      try {
        overlayManager.withHitTestDisabled(() => {
          const t = document.elementFromPoint(e.clientX, e.clientY);
          if (t && !overlayManager.isOwnElement(t)) lastContextEl = t;
        });
      } catch (err) {}
    }
  }, { passive: true, capture: true });

  // FNV-1a - identical to dom_scanner/options so allowlist lookups line up
  function fnvHash(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return ('0000000' + (hash >>> 0).toString(16)).slice(-8);
  }

  /**
   * Generate the most specific robust CSS selector for an element.
   * Prefers #id; otherwise walks up building tag.class:nth-of-type path.
   */
  function buildSelectorForElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE &&
           cur.tagName !== 'HTML' && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      if (cur.classList && cur.classList.length) {
        part += '.' + [...cur.classList].slice(0, 3)
          .map(c => CSS.escape(c)).join('.');
      }
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter(c => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      if (parent && parent.id) { parts.unshift('#' + CSS.escape(parent.id)); break; }
      cur = parent;
    }
    return parts.join(' > ');
  }

  /** Best-effort sensitive text candidate from a right-click target. */
  function extractCandidateValue(el, selectionText) {
    if (selectionText && selectionText.trim().length >= 3) {
      return selectionText.trim();
    }
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (typeof el.value === 'string' && el.value.trim().length >= 3) {
      return el.value.trim();
    }
    const txt = (el.textContent || '').trim();
    return txt.length >= 3 ? txt.slice(0, 160) : '';
  }

  function sendRuntimeMessage(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => {
        if (chrome.runtime.lastError) {}
      });
    } catch (e) {}
  }

  function handleContextAction(msg) {
    if (msg.action === 'SPS_CONTEXT_BLUR_ELEMENT') {
      const selector = buildSelectorForElement(lastContextEl);
      if (!selector) return;
      sendRuntimeMessage({
        action: 'ADD_SELECTOR_RULE',
        rule: {
          id: 'ctx_' + Date.now().toString(36),
          selector,
          label: 'Marked Element',
          category: 'CUSTOM_SELECTOR'
        }
      });
      if (overlayManager) {
        overlayManager.showNoticeToast('Element will stay blurred on this site');
      }
    } else if (msg.action === 'SPS_CONTEXT_NEVER_BLUR') {
      const value = extractCandidateValue(lastContextEl, msg.selectionText);
      if (!value) return;
      sendRuntimeMessage({ action: 'ADD_ALLOWLIST_HASH', hash: fnvHash(value) });
      if (overlayManager) {
        overlayManager.showNoticeToast('Value allowlisted - never blurred');
      }
    } else if (msg.action === 'SPS_CONTEXT_BLUR_SELECTION') {
      const sel = window.getSelection();
      let el = sel && sel.anchorNode
        ? (sel.anchorNode.nodeType === Node.TEXT_NODE
            ? sel.anchorNode.parentElement : sel.anchorNode)
        : lastContextEl;
      while (el && el.nodeType === Node.ELEMENT_NODE &&
             el.offsetHeight < 14 && el.parentElement) {
        el = el.parentElement;
      }
      if (el && overlayManager) {
        overlayManager.addElementOverlay(el, {
          category: 'CUSTOM_SELECTOR',
          ruleId: 'ctx_manual',
          badge: '🎯 MARKED',
          color: '#ec4899',
          value: (el.textContent || '').slice(0, 80)
        });
      }
    } else if (msg.action === 'SUGGEST_PRESENT_MODE') {
      if (overlayManager && !presentModeActive) {
        overlayManager.showPmSuggestion(() => {
          sendRuntimeMessage({
            action: 'SET_PRESENT_MODE', active: true, trigger: 'popup'
          });
        });
      }
    }
  }

  // --- Message listener: settings, rescan, stats, present mode ---
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action && msg.action.startsWith('SPS_CONTEXT_')) {
        handleContextAction(msg);
        sendResponse({ status: 'OK' });
        return false;
      }
      if (msg.action === 'SUGGEST_PRESENT_MODE') {
        handleContextAction(msg);
        sendResponse({ status: 'OK' });
        return false;
      }
      if (msg.action === 'SETTINGS_UPDATED') {
        if (msg.config) {
          initModules(msg.config);
          sendResponse({ status: 'OK' });
        }
      } else if (msg.action === 'RESCAN_PAGE') {
        if (domScanner) {
          if (overlayManager) overlayManager.clearAll();
          domScanner.resetDedup();
          domScanner.scan();
          sendResponse({
            status: 'OK',
            count: overlayManager ? overlayManager.getActiveCount() : 0
          });
        } else {
          sendResponse({ status: 'OK', count: 0 });
        }
      } else if (msg.action === 'GET_PAGE_STATS') {
        sendResponse({
          activeOverlays: overlayManager ? overlayManager.getActiveCount() : 0,
          presentMode: presentModeActive,
          url: window.location.href
        });
      } else if (msg.action === 'PRESENT_MODE_CHANGED') {
        applyPresentMode(!!msg.active, msg.trigger);
        sendResponse({ status: 'OK' });
      }
      // All responses above are synchronous - do not keep the channel open.
      return false;
    });

    // Demo/test bridge: page scripts can't reach this isolated world, so
    // the bundled test page drives Present Mode via a tagged postMessage.
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data || e.data.spsDemo !== 'PRESENT_MODE') return;
      applyPresentMode(!!e.data.on, 'manual');
    });

    // Catch storage changes that bypassed message broadcast
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.sps_config && changes.sps_config.newValue) {
          initModules(changes.sps_config.newValue);
        }
      });
    }

    // Ask service worker for current present-mode state (race with first config load)
    try {
      chrome.runtime.sendMessage({ action: 'GET_PRESENT_MODE' }, (res) => {
        if (!chrome.runtime.lastError && res && res.active !== undefined) {
          // 'active' is the effective state computed by the service worker
          // (manual toggle OR unsuppressed tab capture).
          applyPresentMode(res.active, 'init');
        }
      });
    } catch (e) {}
  }

  // Start orchestrator
  loadConfiguration();
})();
