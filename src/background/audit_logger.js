/**
 * Screen Privacy Shield - Zero-Exposure Audit Logger
 * Hashes all field fingerprints using SHA-256. Never stores or logs raw sensitive values.
 * Manages rolling local storage buffer (up to 2,000 entries) and optional remote webhook dispatch.
 */

(function (global) {
  'use strict';

  const MAX_LOG_ENTRIES = 2000;
  const AUDIT_STORAGE_KEY = 'sps_audit_logs';

  /**
   * Cryptographic SHA-256 hex digest using Web Crypto API
   */
  async function computeSha256(str) {
    if (!str) return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    try {
      const msgBuffer = new TextEncoder().encode(str);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      // Fallback simple hash if subtle crypto fails
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
      }
      return 'fb_' + Math.abs(hash).toString(16);
    }
  }

  class AuditLogger {
    constructor() {
      this.remoteEndpoint = '';
      this.userId = 'device_' + Math.random().toString(36).substring(2, 8);
      this.isLoggingEnabled = true;
      this.pendingBatch = [];
      this.batchTimer = null;
      // Storage write coalescing: hundreds of detections at page load used
      // to trigger a get+set round-trip EACH. Now buffered into one write.
      this.pendingSave = [];
      this.saveTimer = null;
      // Dedup window: identical {eventType,category,ruleId,fieldHash} within
      // 2s is logged once (prevents rescan spam in the audit trail)
      this.recentHashes = new Map();
      this.DEDUP_WINDOW_MS = 2000;
    }

    configure(settings = {}) {
      if (typeof settings.auditLoggingEnabled === 'boolean') {
        this.isLoggingEnabled = settings.auditLoggingEnabled;
      }
      if (typeof settings.remoteAuditEndpoint === 'string') {
        this.remoteEndpoint = settings.remoteAuditEndpoint.trim();
      }
      if (typeof settings.userId === 'string' && settings.userId) {
        this.userId = settings.userId;
      }
    }

    /**
     * Record an audit event
     * @param {Object} eventData
     */
    async logEvent(eventData) {
      if (!this.isLoggingEnabled) return;

      const fieldHash = await computeSha256(eventData.nodeHash || eventData.value || (eventData.category + eventData.ruleId));

      // Dedup rapid-fire identical detection events (rescans, reflows)
      const now = Date.now();
      const dedupKey = `${eventData.eventType || 'DETECTION'}|${eventData.category}|${eventData.ruleId}|${fieldHash}`;
      const lastSeen = this.recentHashes.get(dedupKey) || 0;
      if (now - lastSeen < this.DEDUP_WINDOW_MS &&
          (eventData.eventType || 'DETECTION') === 'DETECTION') {
        return;
      }
      this.recentHashes.set(dedupKey, now);
      // Periodically trim the dedup map
      if (this.recentHashes.size > 500) {
        for (const [k, t] of this.recentHashes) {
          if (now - t > 30000) this.recentHashes.delete(k);
        }
      }

      const entry = {
        id: 'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6),
        timestamp: eventData.timestamp || Date.now(),
        isoTime: new Date(eventData.timestamp || Date.now()).toISOString(),
        eventType: eventData.eventType || 'DETECTION', // 'DETECTION' | 'REVEAL' | 'REBLUR' | 'WARNING'
        category: eventData.category || 'UNKNOWN',
        ruleId: eventData.ruleId || 'generic_rule',
        fieldHash: fieldHash,
        url: this.sanitizeUrl(eventData.url),
        title: (eventData.title || '').substring(0, 100),
        user: this.userId
      };

      // 1. Store in chrome.storage.local
      await this.saveToLocal(entry);

      // 2. Queue for remote dispatch if configured
      if (this.remoteEndpoint) {
        this.queueForRemote(entry);
      }
    }

    sanitizeUrl(rawUrl) {
      if (!rawUrl) return '';
      try {
        const u = new URL(rawUrl);
        // Strip out query parameters and hashes that might contain sensitive tokens
        return u.origin + u.pathname;
      } catch (e) {
        return rawUrl.split('?')[0];
      }
    }

    saveToLocal(entry) {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      this.pendingSave.push(entry);
      if (this.saveTimer) return;
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        const pending = this.pendingSave.splice(0);
        chrome.storage.local.get([AUDIT_STORAGE_KEY], (res) => {
          let logs = res[AUDIT_STORAGE_KEY] || [];
          logs = pending.concat(logs).slice(0, MAX_LOG_ENTRIES);
          chrome.storage.local.set({ [AUDIT_STORAGE_KEY]: logs });
        });
      }, 300);
    }

    queueForRemote(entry) {
      this.pendingBatch.push(entry);

      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          this.flushRemoteBatch();
          this.batchTimer = null;
        }, 5000); // Batch every 5 seconds
      }
    }

    async flushRemoteBatch() {
      if (this.pendingBatch.length === 0 || !this.remoteEndpoint) return;

      const batchToSend = [...this.pendingBatch];
      this.pendingBatch = [];

      try {
        await fetch(this.remoteEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client: 'ScreenPrivacyShield',
            events: batchToSend
          })
        });
      } catch (err) {
        console.warn('[ScreenShield] Remote audit dispatch failed:', err);
      }
    }

    /**
     * Clear all local audit logs
     */
    static clearLogs(callback) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [AUDIT_STORAGE_KEY]: [] }, callback);
      }
    }

    /**
     * Export logs as CSV format
     */
    static formatCsv(logs) {
      const headers = ['Event ID', 'Timestamp', 'ISO Time', 'Event Type', 'Category', 'Rule ID', 'Field Hash', 'Page URL', 'User ID'];
      const rows = logs.map(e => [
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

      return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AuditLogger, computeSha256 };
  } else {
    global.ScreenShieldAuditLogger = AuditLogger;
  }
})(typeof window !== 'undefined' ? window : globalThis);
