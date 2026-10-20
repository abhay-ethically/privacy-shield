/**
 * Screen Privacy Shield - DOM Scanner
 * High-performance visible text traversal.
 *
 * v2.0 capabilities:
 *  - Subtree-scoped incremental scans: MutationObserver batches enqueue only the
 *    affected roots instead of re-walking document.body.
 *  - Shadow DOM recursion: open shadow roots are traversed AND observed.
 *  - Form field scanning: input.value / textarea.value / title / alt /
 *    aria-label / placeholder get element-level overlays.
 *  - Budgeted scanning: DFS work queue time-sliced across animation frames.
 *  - IntersectionObserver wired for previously-hidden content.
 *  - Detection dedup: audits fire only for genuinely new overlays.
 */

(function (global) {
  'use strict';

  const IGNORED_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD',
    'IFRAME', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO', 'CANVAS',
    'NOSCRIPT', 'IFRAME', 'SLOT'
  ]);
  const CONTAINER_ID = 'screen-privacy-shield-container';
  const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA']);
  // Cheap gate: every built-in rule requires at least one of these chars.
  // Pure-prose text nodes skip the ~20-rule regex pass entirely.
  const INTERESTING = /[0-9@=_:+\-./]/;
  const FIELD_INPUT_TYPES_SKIP = new Set([
    'checkbox', 'radio', 'submit', 'button', 'reset', 'file',
    'image', 'range', 'color', 'hidden'
  ]);
  const PII_ATTRIBUTES = ['title', 'alt', 'aria-label', 'placeholder'];
  const NODE_BUDGET = 400;        // max nodes per frame slice
  const TIME_BUDGET_MS = 12;      // max ms per frame slice
  const MAX_WAIT_MS = 300;        // debounce starvation cap

  function mHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }

  class DomScanner {
    constructor(options = {}) {
      this.regexEngine = options.regexEngine;
      this.overlayManager = options.overlayManager;
      this.nerDetector = options.nerDetector || null;
      this.ocrDetector = options.ocrDetector || null;
      this.onDetection = options.onDetection || (() => {});
      this.selectorRules = options.selectorRules || [];
      this.allowlistedHashes = options.allowlistedHashes || new Set();
      this.enabled = options.enabled !== false;

      this.debounceTimer = null;
      this.debounceDelayMs = options.debounceDelayMs || 60;
      this.firstPendingAt = 0;

      // Incremental scan work queue (explicit DFS stack for time-slicing)
      this.scanQueue = [];        // pending subtree roots
      this.queuedNodes = new Set(); // membership dedupe - mutation storms
      this.scanStack = null;      // active DFS stack

      // Caches / dedup
      this.scannedNodes = new WeakMap();        // TextNode -> last text
      this.nodeMatchKey = new WeakMap();        // TextNode -> last detection signature
      this.scannedFields = new WeakMap();       // input/textarea -> last value
      this.detectedSelectorEls = new WeakSet(); // elements already reported
      this.observedShadowRoots = new WeakSet(); // shadow roots being observed
      this.pendingHidden = new WeakSet();       // elements already IO-observed

      this.initObservers();
    }

    setEnabled(val) {
      this.enabled = !!val;
    }

    /**
     * Drop all scan/dedup caches. REQUIRED after overlayManager.clearAll():
     * without it, already-scanned nodes are skipped and overlays never
     * get rebuilt.
     */
    resetDedup() {
      this.scannedNodes = new WeakMap();
      this.nodeMatchKey = new WeakMap();
      this.scannedFields = new WeakMap();
      this.detectedSelectorEls = new WeakSet();
      this.pendingHidden = new WeakSet();
      this.pendingHiddenCount = 0;
      this.queuedNodes.clear();
    }

    updateSelectorRules(rules) {
      this.selectorRules = Array.isArray(rules) ? rules : [];
    }

    updateAllowlist(hashes) {
      this.allowlistedHashes = hashes instanceof Set ? hashes : new Set(hashes || []);
    }

    // ---------------------------------------------------------------
    // Observers
    // ---------------------------------------------------------------

    initObservers() {
      this.mutationObserver = new MutationObserver((mutations) => {
        this.handleMutations(mutations);
      });

      const observeRoot = (root) => {
        if (!root) return;
        // NOTE: deliberately NO 'class'/'style' in attributeFilter - those
        // mutate on every animation frame on real pages and caused constant
        // re-scan churn. Layout drift is covered by the overlay position
        // sweep + ResizeObserver + capture-scroll sync instead.
        this.mutationObserver.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['title', 'alt', 'aria-label', 'placeholder', 'value', 'open', 'hidden']
        });
      };
      this._observeRoot = observeRoot;

      if (document.documentElement) observeRoot(document.documentElement);
      else {
        document.addEventListener('DOMContentLoaded',
          () => observeRoot(document.documentElement), { once: true });
      }

      // Fields that change value via typing fire 'input' (no DOM mutation).
      // scanField is a single-element regex pass - cheap enough to run
      // synchronously per keystroke so secrets are covered ~0ms after they
      // appear instead of leaking for a debounce window.
      document.addEventListener('input', (e) => {
        const t = e.target;
        if (t && FIELD_TAGS.has(t.tagName) && this.enabled) {
          try { this.scanField(t); } catch (err) {}
        }
      }, { passive: true, capture: true });

      // IntersectionObserver: rescan elements that became visible
      if (typeof IntersectionObserver !== 'undefined') {
        this.intersectionObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              this.intersectionObserver.unobserve(entry.target);
              if (this.pendingHidden.delete(entry.target)) {
                this.pendingHiddenCount = Math.max(0, (this.pendingHiddenCount || 0) - 1);
              }
              this.enqueueSubtree(entry.target);
            }
          }
        }, { root: null, rootMargin: '200px 0px 200px 0px', threshold: 0.01 });
      }

      // Layout shifts (fonts, async stylesheets) move overlay rects.
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => {
          if (this.overlayManager) this.overlayManager.requestSync();
        });
        const watchResize = () => {
          if (document.documentElement) {
            this.resizeObserver.observe(document.documentElement);
          }
        };
        if (document.documentElement) watchResize();
        else document.addEventListener('DOMContentLoaded', watchResize, { once: true });
      }

      // Webfont loading changes glyph metrics -> re-sync overlay rects once.
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          if (this.overlayManager) this.overlayManager.requestSync();
        });
      }

      // Field sweep: programmatic value changes (el.value = ..., password
      // managers, some autofill paths) fire no events/mutations at all.
      this.fieldSweepTimer = setInterval(() => {
        if (!this.enabled || document.hidden) return;
        try {
          const fields = document.querySelectorAll('input, textarea');
          for (const f of fields) {
            if (this.scannedFields.get(f) !== f.value) this.scanField(f);
          }
        } catch (e) {}
      }, 2000);
    }

    handleMutations(mutations) {
      if (!this.enabled) return;
      for (const mut of mutations) {
        const t = mut.target;
        if (this.isOurNode(t)) continue;

        for (const node of mut.removedNodes) {
          this.cleanNodeOverlays(node);
        }

        if (mut.type === 'characterData' && mut.target.nodeType === Node.TEXT_NODE) {
          this.scannedNodes.delete(mut.target);
          this.nodeMatchKey.delete(mut.target);
          this.overlayManager.removeOverlaysForNode(mut.target);
          if (mut.target.parentElement) this.enqueueSubtree(mut.target);
        } else if (mut.type === 'attributes') {
          // Targeted re-check: attribute mutations only need field/attr
          // rescan, plus a subtree pass for visibility flips (hidden/open).
          const el = mut.target;
          if (el && el.nodeType === Node.ELEMENT_NODE) {
            if (FIELD_TAGS.has(el.tagName)) this.scanField(el);
            this.scanAttributes(el);
            if (mut.attributeName === 'open' || mut.attributeName === 'hidden') {
              this.enqueueSubtree(el);
            }
          }
        } else {
          for (const node of mut.addedNodes) {
            this.enqueueSubtree(node);
          }
        }
      }
    }

    cleanNodeOverlays(rootNode) {
      if (rootNode.nodeType === Node.TEXT_NODE) {
        this.overlayManager.removeOverlaysForNode(rootNode);
        this.scannedNodes.delete(rootNode);
        this.nodeMatchKey.delete(rootNode);
      } else if (rootNode.nodeType === Node.ELEMENT_NODE) {
        this.overlayManager.removeOverlaysForElement(rootNode);
        this.scannedFields.delete(rootNode);
        const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, null);
        let tn;
        while ((tn = walker.nextNode())) {
          this.overlayManager.removeOverlaysForNode(tn);
          this.scannedNodes.delete(tn);
          this.nodeMatchKey.delete(tn);
        }
      }
    }

    /** True for nodes inside (or being) any ScreenShield overlay container. */
    isOurNode(node) {
      if (!node) return false;
      if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
      if (!node) return false;
      if (node.id === CONTAINER_ID) return true;
      if (node.classList && node.classList.contains('sps-tl-container')) return true;
      return !!(node.closest &&
        node.closest('#' + CONTAINER_ID + ', .sps-tl-container'));
    }

    // ---------------------------------------------------------------
    // Scan scheduling (debounced with max-wait, then frame-budgeted)
    // ---------------------------------------------------------------

    /** Enqueue a subtree root (element or text node) for scanning. */
    enqueueSubtree(node) {
      if (!node || !this.enabled) return;
      if (this.queuedNodes.has(node)) return; // storm dedupe
      this.queuedNodes.add(node);
      this.scanQueue.push(node);
      this.scheduleScan(this.debounceDelayMs);
    }

    scheduleScan(delay = this.debounceDelayMs) {
      // Starvation cap: under a continuous mutation stream the debounce
      // would reset forever - force a flush after MAX_WAIT_MS.
      const now = performance.now();
      if (!this.firstPendingAt) this.firstPendingAt = now;
      if (now - this.firstPendingAt > MAX_WAIT_MS) delay = 0;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.firstPendingAt = 0;
        this.processScanQueue();
      }, delay);
    }

    /** Full scan: enqueue body's children viewport-first + selector rules. */
    scan(root = document.body) {
      if (!root || !this.enabled) return;
      this.scanSelectorRules(document);
      if (root === document.body) {
        this.enqueueViewportFirst(root);
      } else {
        this.enqueueSubtree(root);
      }
      // Full scans get a boosted slice budget so first-paint coverage
      // lands fast on big pages; incremental work stays conservative.
      this._boostScan = true;
      this.scheduleScan(0);
    }

    /**
     * Order a full scan so on-screen content is protected first.
     * One bounded getBoundingClientRect pass over body's top-level
     * children (~tens of reads, once per scan) partitions them into
     * viewport-intersecting vs far-offscreen roots. The queue drains
     * FIFO, so visible roots are enqueued first.
     */
    enqueueViewportFirst(root) {
      const vh = window.innerHeight || 0;
      const MARGIN = 400;
      const visible = [];
      const offscreen = [];
      for (const child of root.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.nodeValue && child.nodeValue.trim()) visible.push(child);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        let r = null;
        try { r = child.getBoundingClientRect(); } catch (e) {}
        if (r && (r.bottom < -MARGIN || r.top > vh + MARGIN)) {
          offscreen.push(child);
        } else {
          visible.push(child);
        }
      }
      for (const n of visible) this.enqueueSubtree(n);
      for (const n of offscreen) this.enqueueSubtree(n);
    }

    /** Frame-budgeted DFS processing of the scan queue. */
    processScanQueue() {
      if (!this.scanStack) this.scanStack = [];

      // Drain newly queued roots into the stack
      while (this.scanQueue.length) {
        const n = this.scanQueue.pop();
        this.queuedNodes.delete(n);
        this.scanStack.push(n);
      }

      const nodeBudget = this._boostScan ? NODE_BUDGET * 3 : NODE_BUDGET;
      const deadline = performance.now() +
        (this._boostScan ? TIME_BUDGET_MS * 2 : TIME_BUDGET_MS);
      let processed = 0;

      while (this.scanStack.length) {
        if (processed >= nodeBudget || performance.now() > deadline) {
          // Yield: continue next frame
          requestAnimationFrame(() => this.processScanQueue());
          return;
        }

        const node = this.scanStack.pop();
        processed++;
        this.visitNode(node, this.scanStack);
      }

      this.scanStack = null;
      this._boostScan = false;
      if (this.overlayManager) this.overlayManager.requestSync();
    }

    /**
     * Visit one node in DFS: process text nodes / fields / attributes,
     * and push children (including shadow DOM) onto the stack.
     */
    visitNode(node, stack) {
      if (!node) return;

      if (node.nodeType === Node.TEXT_NODE) {
        this.scanTextNode(node);
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      // Never descend into our own containers (main or top-layer hosts)
      if (node.id === CONTAINER_ID ||
          (node.classList && node.classList.contains('sps-tl-container')) ||
          (node.closest && node.closest('#' + CONTAINER_ID))) return;

      const tag = node.tagName;

      // Elements fully covered by a chip need no descendant scanning -
      // inner text matches would only create invisible overlays.
      // If the element gets uncovered, onElementUnmasked re-enqueues it.
      if (this.overlayManager && this.overlayManager.isElementCovered(node)) {
        return;
      }

      // Newly added media: register with the OCR observer and process
      // only if not already handled (processCanvas/processImage use
      // their own processedElements staleness map internally).
      if ((tag === 'CANVAS' || tag === 'IMG') &&
          this.ocrDetector && this.ocrDetector.enabled) {
        try {
          this.ocrDetector.observeMedia(node);
          if (!this.ocrDetector.processedElements.has(node)) {
            if (tag === 'CANVAS') this.ocrDetector.processCanvas(node);
            else this.ocrDetector.processImage(node);
          }
        } catch (e) {}
      }

      if (IGNORED_TAGS.has(tag)) return;

      // Shadow DOM: observe + traverse open shadow roots
      if (node.shadowRoot) {
        if (!this.observedShadowRoots.has(node.shadowRoot)) {
          this.observedShadowRoots.add(node.shadowRoot);
          try {
            this._observeRoot(node.shadowRoot);
          } catch (e) {}
        }
        for (const child of node.shadowRoot.childNodes) {
          stack.push(child);
        }
      }

      // Form fields
      if (FIELD_TAGS.has(tag)) {
        this.scanField(node);
      }

      // Attribute-carried PII
      this.scanAttributes(node);

      // Custom selector rules on dynamically-added elements: full scans
      // apply them via scanSelectorRules, but mutation-added subtrees only
      // reach visitNode - check each element against the (small) ruleset
      // so injected salary tables/cards get covered without a rescan.
      if (this.selectorRules.length) {
        for (const rule of this.selectorRules) {
          if (!rule.selector || this.detectedSelectorEls.has(node)) continue;
          try {
            if (node.matches(rule.selector)) {
              const id = this.overlayManager.addElementOverlay(node, {
                category: rule.category || 'CUSTOM_SELECTOR',
                ruleId: rule.id || 'selector_rule',
                badge: rule.label ? `🎯 ${rule.label}` : '🎯 CONFIDENTIAL',
                color: '#ec4899',
                value: node.innerText || ''
              });
              if (id && !this.detectedSelectorEls.has(node)) {
                this.detectedSelectorEls.add(node);
                this.onDetection({
                  category: rule.category || 'CUSTOM_SELECTOR',
                  ruleId: rule.id || 'selector_rule',
                  badge: rule.label || 'CONFIDENTIAL',
                  url: window.location.href, timestamp: Date.now()
                });
              }
              break; // one covering overlay per element is enough
            }
          } catch (e) { /* invalid selector - skip */ }
        }
      }

      // Cheap traversal gate: skip hidden subtrees without touching layout.
      // Per-node visibility is checked lazily in scanTextNode instead of
      // running checkVisibility on EVERY element (that layout probing was
      // the main page-load slowdown).
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') {
        this.deferUntilVisible(node);
        return; // don't descend
      }

      // Children (light DOM)
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        stack.push(node.childNodes[i]);
      }
    }

    isElementVisible(elem) {
      if (!elem || elem.nodeType !== Node.ELEMENT_NODE) return false;
      if (IGNORED_TAGS.has(elem.tagName)) return false;
      if (elem.hidden) return false;

      // checkVisibility (Chrome 105+) reads cached style/layout - cheap.
      // We deliberately do NOT fall back to getComputedStyle/offsetWidth:
      // those force synchronous layout and caused page-load jank.
      if (typeof elem.checkVisibility === 'function') {
        try {
          return elem.checkVisibility({
            checkVisibilityCSS: true,
            checkOpacity: true
          });
        } catch (e) { /* fall through */ }
      }
      return true;
    }

    deferUntilVisible(elem) {
      if (!this.intersectionObserver || this.pendingHidden.has(elem)) return;
      // Bound the observer set - pathological pages can have thousands of
      // hidden nodes.
      if (this.pendingHiddenCount > 800) return;
      // Skip elements with no scannable content
      try {
        if (!elem.textContent || !elem.textContent.trim()) return;
      } catch (e) {}
      this.pendingHidden.add(elem);
      this.pendingHiddenCount = (this.pendingHiddenCount || 0) + 1;
      try {
        this.intersectionObserver.observe(elem);
      } catch (e) {}
    }

    // ---------------------------------------------------------------
    // Per-node detectors
    // ---------------------------------------------------------------

    scanTextNode(node) {
      const parent = node.parentElement;
      if (!parent) return;
      if (parent.id === CONTAINER_ID ||
          parent.closest('#' + CONTAINER_ID + ', .sps-tl-container')) return;
      if (IGNORED_TAGS.has(parent.tagName)) return;

      const text = node.nodeValue;
      if (!text || text.trim().length < 3) return;

      if (this.scannedNodes.get(node) === text) return;

      // Visibility gate BEFORE caching: a node scanned while hidden must
      // still be re-scannable when it becomes visible later.
      if (!this.isElementVisible(parent)) {
        this.deferUntilVisible(parent);
        return;
      }
      this.scannedNodes.set(node, text);

      // Prose-only nodes: no regex rule can match, but NER still wants them
      // (names, orgs, locations live in plain sentences).
      if (!INTERESTING.test(text)) {
        if (this.nerDetector && this.nerDetector.enabled) {
          this.nerDetector.scanTextNode(node, String(mHash(text)));
        }
        return;
      }

      const matches = this.regexEngine.findMatches(text);
      const matchKey = matches.map(m => `${m.ruleId}:${m.start}:${m.end}`).join('|');

      // Identical detection set as last scan -> nothing to do
      if (this.nodeMatchKey.get(node) === matchKey) return;
      this.nodeMatchKey.set(node, matchKey);
      this.overlayManager.removeOverlaysForNode(node);

      for (const m of matches) {
        if (this.allowlistedHashes.has(hashValue(m.value))) continue;
        try {
          const range = document.createRange();
          range.setStart(node, m.start);
          range.setEnd(node, m.end);
          const id = this.overlayManager.addRangeOverlay(range, m);
          if (id) {
            this.onDetection({
              category: m.category, ruleId: m.ruleId, badge: m.badge,
              url: window.location.href, timestamp: Date.now()
            });
          }
        } catch (e) { /* node boundary moved */ }
      }

      if (this.nerDetector && this.nerDetector.enabled) {
        this.nerDetector.scanTextNode(node, String(mHash(text)));
      }
    }

    scanField(el) {
      if (FIELD_INPUT_TYPES_SKIP.has((el.type || '').toLowerCase())) return;
      const value = el.value;
      if (!value || value.length < 3 || !INTERESTING.test(value)) {
        if (this.scannedFields.has(el)) {
          this.scannedFields.delete(el);
          this.overlayManager.removeOverlaysForElement(el);
        }
        return;
      }
      if (this.scannedFields.get(el) === value) return;
      this.scannedFields.set(el, value);

      const matches = this.regexEngine.findMatches(value);
      this.overlayManager.removeOverlaysForElement(el);
      if (matches.length === 0) return;

      const m = matches[0];
      if (this.allowlistedHashes.has(hashValue(m.value))) return;
      const id = this.overlayManager.addElementOverlay(el, {
        category: m.category,
        ruleId: 'field_' + m.ruleId,
        badge: `⌨️ ${m.badge}`,
        color: m.color,
        value: m.value,
        directBlur: true
      });
      if (id) {
        this.onDetection({
          category: m.category, ruleId: 'field_' + m.ruleId,
          badge: m.badge, url: window.location.href, timestamp: Date.now()
        });
      }
    }

    scanAttributes(el) {
      for (const attr of PII_ATTRIBUTES) {
        let v = null;
        try { v = el.getAttribute(attr); } catch (e) {}
        if (!v || v.length < 5 || !INTERESTING.test(v)) continue;
        const matches = this.regexEngine.findMatches(v);
        if (matches.length > 0) {
          const m = matches[0];
          if (this.allowlistedHashes.has(hashValue(m.value))) continue;
          this.overlayManager.addElementOverlay(el, {
            category: m.category,
            ruleId: 'attr_' + m.ruleId,
            badge: `🏷️ ${m.badge}`,
            color: m.color,
            value: m.value
          });
          break;
        }
      }
    }

    // ---------------------------------------------------------------
    // Selector rules
    // ---------------------------------------------------------------

    scanSelectorRules(scopeRoot = document) {
      if (!this.selectorRules || this.selectorRules.length === 0) return;
      if (!scopeRoot.querySelectorAll) return;

      for (const rule of this.selectorRules) {
        if (!rule.selector) continue;
        let elements;
        try {
          elements = scopeRoot.querySelectorAll(rule.selector);
        } catch (selErr) {
          console.warn('[ScreenShield] Invalid selector rule:', rule.selector);
          continue;
        }
        for (const el of elements) {
          if (el.id === CONTAINER_ID ||
              el.closest('#' + CONTAINER_ID)) continue;
          if (!this.isElementVisible(el)) {
            this.deferUntilVisible(el);
            continue;
          }
          const id = this.overlayManager.addElementOverlay(el, {
            category: rule.category || 'CUSTOM_SELECTOR',
            ruleId: rule.id || 'selector_rule',
            badge: rule.label ? `🎯 ${rule.label}` : '🎯 CONFIDENTIAL',
            color: '#ec4899',
            value: el.innerText || ''
          });
          // Audit only first time this element produces an overlay
          if (id && !this.detectedSelectorEls.has(el)) {
            this.detectedSelectorEls.add(el);
            this.onDetection({
              category: rule.category || 'CUSTOM_SELECTOR',
              ruleId: rule.id || 'selector_rule',
              badge: rule.label || 'CONFIDENTIAL',
              url: window.location.href, timestamp: Date.now()
            });
          }
        }
      }
    }

    destroy() {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      if (this.fieldSweepTimer) clearInterval(this.fieldSweepTimer);
      if (this.mutationObserver) this.mutationObserver.disconnect();
      if (this.intersectionObserver) this.intersectionObserver.disconnect();
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.scanQueue.length = 0;
      this.queuedNodes.clear();
      this.scanStack = null;
    }
  }

  // FNV-ish hash for allowlist lookups (same algorithm as overlay hash)
  function hashString(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return ('0000000' + (hash >>> 0).toString(16)).slice(-8);
  }

  // The allowlist stores FNV-1a hashes of raw values (computed by the
  // options page), so raw PII is never persisted. The cheap hash keeps
  // the scan hot path fully synchronous.
  function hashValue(str) {
    return hashString(str || '');
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DomScanner };
  } else {
    global.ScreenShieldDomScanner = DomScanner;
  }
})(typeof window !== 'undefined' ? window : globalThis);
