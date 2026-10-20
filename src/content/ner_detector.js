/**
 * Screen Privacy Shield - On-Device NER Detector
 * Integrates on-device Named Entity Recognition (NER) for unstructured PII:
 * Names (PER), Addresses/Locations (LOC), Organizations (ORG), and confidential terms.
 * Runs 100% locally via a bundled Transformers.js ONNX pipeline inside the
 * offscreen document (loaded by the service worker on demand).
 *
 * Batches text-node requests (300ms window / 8 items) to cut message overhead.
 */

(function (global) {
  'use strict';

  const BATCH_WINDOW_MS = 300;
  const BATCH_MAX = 8;
  const CACHE_MAX = 2000;

  class NerDetector {
    constructor(options = {}) {
      this.overlayManager = options.overlayManager;
      this.onDetection = options.onDetection || (() => {});
      this.enabled = !!options.enabled;
      this.cache = new Map();         // textHash -> Array<entities>
      this.pendingNodes = new Map();  // nodeHash -> textNode (queued for batch)
      this.pendingTexts = new Map();  // nodeHash -> text
      this.batchTimer = null;
    }

    setEnabled(val) {
      this.enabled = !!val;
    }

    /**
     * Queue a text node for NER analysis
     */
    scanTextNode(textNode, nodeHash) {
      if (!this.enabled || !textNode || !textNode.nodeValue) return;

      // Use the RAW node value for inference - entity start/end offsets are
      // applied to the same node via Range, so the text must not be trimmed
      // or offsets would shift by the leading whitespace.
      const raw = textNode.nodeValue;
      const text = raw.trim();
      if (text.length < 5 || text.split(/\s+/).length < 2) {
        return; // too short to be a useful NER candidate
      }

      if (this.cache.has(nodeHash)) {
        this.applyEntities(textNode, this.cache.get(nodeHash));
        return;
      }

      this.pendingNodes.set(nodeHash, textNode);
      this.pendingTexts.set(nodeHash, raw);

      if (this.pendingTexts.size >= BATCH_MAX) {
        this.flushBatch();
      } else if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.flushBatch(), BATCH_WINDOW_MS);
      }
    }

    flushBatch() {
      if (this.batchTimer) {
        clearTimeout(this.batchTimer);
        this.batchTimer = null;
      }
      if (this.pendingTexts.size === 0) return;
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        this.pendingTexts.clear();
        this.pendingNodes.clear();
        return;
      }

      const texts = [];
      for (const [nodeHash, text] of this.pendingTexts) {
        texts.push({ nodeHash, text });
      }
      this.pendingTexts.clear();
      // Track THIS batch's keys so response processing can clean up
      // pendingNodes without wiping entries queued during the flight.
      const batchKeys = new Set(texts.map(t => t.nodeHash));

      try {
        chrome.runtime.sendMessage({
          action: 'RUN_NER_OFFSCREEN',
          texts
        }, (response) => {
          if (!chrome.runtime.lastError && response && response.entitiesByHash) {
            for (const [nodeHash, entities] of Object.entries(response.entitiesByHash)) {
              const node = this.pendingNodes.get(nodeHash);
              this.cacheSet(nodeHash, entities || []);
              if (node && node.isConnected) {
                this.applyEntities(node, entities || []);
              }
            }
          }
          // Clean this batch's node refs - entries absent from the
          // response must not linger (new arrivals queued during the
          // flight are outside batchKeys and stay queued).
          for (const k of batchKeys) this.pendingNodes.delete(k);
        });
      } catch (e) {
        for (const k of batchKeys) this.pendingNodes.delete(k);
      }
    }

    cacheSet(hash, entities) {
      if (this.cache.size >= CACHE_MAX) {
        // Trim oldest ~25% (Map preserves insertion order)
        const drop = Math.floor(CACHE_MAX / 4);
        let i = 0;
        for (const k of this.cache.keys()) {
          this.cache.delete(k);
          if (++i >= drop) break;
        }
      }
      this.cache.set(hash, entities);
    }

    /**
     * Apply blur overlays for detected entities
     */
    applyEntities(textNode, entities) {
      if (!entities || entities.length === 0 || !textNode.parentNode) return;
      if (!textNode.isConnected) return;

      const typeBadges = {
        PER: '👤 PERSON',
        LOC: '📍 LOCATION',
        ORG: '🏢 ORG',
        MISC: '🏷️ ENTITY'
      };

      for (const ent of entities) {
        try {
          const range = document.createRange();
          range.setStart(textNode, ent.start);
          range.setEnd(textNode, ent.end);

          const id = this.overlayManager.addRangeOverlay(range, {
            category: 'NER_ENTITY',
            ruleId: 'ner_' + ent.type.toLowerCase(),
            badge: typeBadges[ent.type] || '🧠 NER',
            color: '#a855f7',
            value: ent.word
          });

          if (id) {
            this.onDetection({
              category: 'NER_ENTITY',
              ruleId: 'ner_' + ent.type.toLowerCase(),
              badge: typeBadges[ent.type] || 'NER',
              url: window.location.href,
              timestamp: Date.now()
            });
          }
        } catch (err) {
          // Range boundary mismatch on dynamic nodes
        }
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NerDetector };
  } else {
    global.ScreenShieldNerDetector = NerDetector;
  }
})(typeof window !== 'undefined' ? window : globalThis);
