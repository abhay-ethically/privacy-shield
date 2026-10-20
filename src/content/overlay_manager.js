/**
 * Screen Privacy Shield - Overlay Manager
 * Manages an isolated Shadow DOM container with non-destructive blur overlays.
 *
 * v2.0 capabilities:
 *  - Document-coordinate (position:absolute) overlays that scroll natively at 120fps.
 *  - Capture-phase scroll sync -> stays locked inside nested overflow containers.
 *  - visualViewport tracking for pinch-zoom.
 *  - Batched layout reads/writes (no per-overlay layout thrash).
 *  - Multi-line range support via range.getClientRects() with per-rect children.
 *  - Top-layer awareness: remounts inside fullscreen/modal dialog/popover hosts.
 *  - Present Mode: opaque hard-redaction bars + watermark + ribbon indicator.
 *  - Overlay budget with overflow counter.
 *  - Self-healing: re-mounts if the host page removes our container.
 */

(function (global) {
  'use strict';

  const CONTAINER_ID = 'screen-privacy-shield-container';
  const MAX_OVERLAYS_DEFAULT = 300;
  const RECT_PAD = 2;

  function hashString(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return ('0000000' + (hash >>> 0).toString(16)).slice(-8);
  }

  class OverlayManager {
    constructor(options = {}) {
      this.hoverController = options.hoverController || null;
      this.container = null;
      this.shadowRoot = null;
      this.styleElement = null;
      this.overlays = new Map(); // overlayId -> overlayRecord
      this.rafPending = false;
      this.blurIntensity = options.blurIntensity || 8;
      this.maxOverlays = options.maxOverlays || MAX_OVERLAYS_DEFAULT;
      this.overflowCount = 0;
      this.overflowBadgeEl = null;

      this.presentMode = false;
      this.presentOpaque = true;
      this._pmLocked = false;
      this.watermarkText = options.watermarkText || '';
      this._watermarkOn = false;

      // Per-top-layer shadow containers: modal <dialog>, fullscreen elements,
      // and open popovers paint above document-level overlays, so each gets its
      // own host container whose rect children use position:fixed viewport coords.
      this.topLayerHosts = new Map(); // hostEl -> { container, shadowRoot, styleElement }
      this.shadowUI = new Map();      // shadowRoot -> { ribbon, watermark }
      this.cssText = '';

      this.topLayerHost = null; // element currently hosting the container
      this.selfHealObserver = null;

      this.initShadowDom();
      this.initListeners();
      this.initSelfHeal();
      // If initShadowDom removed a stale container, rebuild chips now that
      // the sync scheduler is wired.
      if (this._needsChipRebuild) {
        this._needsChipRebuild = false;
        this.requestSync();
      }
    }

    // ---------------------------------------------------------------
    // Container / Shadow DOM
    // ---------------------------------------------------------------

    initShadowDom() {
      const existing = document.getElementById(CONTAINER_ID);
      if (existing) {
        existing.remove();
        // Any surviving records now point at detached chips - drop them so
        // the next sync rebuilds fresh elements into the new shadow root.
        if (this.overlays) {
          for (const [, rec] of this.overlays) {
            if (rec.rectEls) {
              rec.rectEls = rec.rectEls.filter(el => el.isConnected);
              rec.overlayEl = rec.rectEls[0] || null;
            }
          }
          this._needsChipRebuild = true;
        }
      }

      this.container = document.createElement('div');
      this.container.id = CONTAINER_ID;
      this.container.style.cssText =
        'position:absolute;top:0;left:0;width:100%;min-height:100%;' +
        'pointer-events:none;z-index:2147483647;contain:layout style;';

      this.shadowRoot = this.container.attachShadow({ mode: 'open' });
      this.styleElement = document.createElement('style');
      this.shadowRoot.appendChild(this.styleElement);

      // Leaf elements (input/textarea) are blurred directly with
      // filter:blur() on the element itself - zero overlay filter cost.
      this.maskedElements = new Map(); // el -> original style.filter
      // element -> record for ELEMENT overlays; lets the scanner skip
      // descending into containers already fully covered by a chip.
      this.coveredElements = new WeakMap();
      // O(1) reverse indexes: node/element -> overlay ids. Without them
      // every removal is a full Map scan - O(mutations x overlays) on
      // mutation-heavy pages.
      this.nodeRecords = new WeakMap();    // TextNode -> Set<id>
      this.elementRecords = new WeakMap(); // Element -> Set<id> (ELEMENT + OCR_BOX)
      // Records whose content sits inside position:sticky containers must
      // be re-glued live during document scroll (they move relative to
      // the document while stuck).
      this.stickyRecords = new Set(); // id

      this.mountContainer();
    }

    getOverlayHost() {
      // Top-layer elements (fullscreen, modal dialogs, popovers) paint above
      // everything else - the container must live inside the top-layer element.
      if (document.fullscreenElement) return document.fullscreenElement;
      return document.body || document.documentElement;
    }

    mountContainer() {
      const target = this.getOverlayHost();
      if (target && this.container.parentNode !== target) {
        target.appendChild(this.container);
        this.topLayerHost = target;
      }
    }

    initSelfHeal() {
      // If the host page removes our container (some apps clean unknown
      // nodes), re-mount it. Callback is a cheap connectivity check.
      this.selfHealObserver = new MutationObserver(() => {
        if (!this.container.isConnected) {
          this.mountContainer();
        }
        // Heal top-layer shadow containers evicted by the host page
        for (const [hostEl, rec] of this.topLayerHosts) {
          if (hostEl.isConnected && !rec.container.isConnected) {
            try { hostEl.appendChild(rec.container); } catch (e) {}
          }
        }
      });
      const watch = () => {
        const root = document.body || document.documentElement;
        if (root) {
          this.selfHealObserver.observe(document.documentElement, {
            childList: true, subtree: true
          });
        }
      };
      if (document.documentElement) watch();
      else document.addEventListener('DOMContentLoaded', watch, { once: true });
    }

    injectStyles(cssContent) {
      // __SPS_BLUR__ is resolved against the configured blur intensity so
      // the Options slider takes effect without a reload. The raw
      // (tokened) source is kept so setBlurIntensity can re-resolve.
      this._rawCss = cssContent;
      this.blurIntensity = Math.max(2, Math.min(24, this.blurIntensity || 8));
      const resolved = String(cssContent).replaceAll(
        '__SPS_BLUR__', `blur(${this.blurIntensity}px)`);
      this.cssText = resolved;
      if (this.styleElement) this.styleElement.textContent = resolved;
      this.forEachTopLayerShadow(rec => {
        if (rec.styleElement) rec.styleElement.textContent = resolved;
      });
    }

    /** Live-update blur strength: restyle chips + re-mask leaf elements. */
    setBlurIntensity(px) {
      px = Math.max(2, Math.min(24, parseInt(px, 10) || 8));
      if (px === this.blurIntensity) return;
      this.blurIntensity = px;
      if (this._rawCss) this.injectStyles(this._rawCss);
      // Re-apply element masks at the new strength
      for (const el of [...this.maskedElements.keys()]) {
        this.restoreElementMask(el);
      }
      this.syncElementMasks();
    }

    // ---------------------------------------------------------------
    // Top-layer shadow hosts (fullscreen / modal dialog / popover)
    // ---------------------------------------------------------------

    forEachTopLayerShadow(cb) {
      for (const [, rec] of this.topLayerHosts) cb(rec);
    }

    forEachShadow(cb) {
      cb(this.shadowRoot);
      this.forEachTopLayerShadow(rec => cb(rec.shadowRoot));
    }

    uiFor(shadowRoot) {
      let ui = this.shadowUI.get(shadowRoot);
      if (!ui) { ui = {}; this.shadowUI.set(shadowRoot, ui); }
      return ui;
    }

    /**
     * Walk the composed tree (crossing open shadow boundaries) to find the
     * nearest top-layer ancestor: fullscreen element, open <dialog>, or
     * open popover. Returns the host element or null for normal document flow.
     */
    resolveContext(el) {
      const fs = document.fullscreenElement;
      let node = el;
      while (node) {
        if (fs && node === fs) return node;
        if (node.tagName === 'DIALOG' && node.open) return node;
        if (node.hasAttribute && node.hasAttribute('popover') &&
            node.matches && node.matches(':popover-open')) return node;
        node = node.parentNode ||
          (node.getRootNode && node.getRootNode().host) || null;
      }
      return null;
    }

    /**
     * Get (or lazily create) the shadow root that overlays for a top-layer
     * host element must live in. Rect children inside it use position:fixed
     * with viewport coordinates.
     */
    getShadowRootForContext(hostEl) {
      if (!hostEl || !hostEl.isConnected) return this.shadowRoot;
      let rec = this.topLayerHosts.get(hostEl);
      if (rec && !rec.container.isConnected) {
        this.shadowUI.delete(rec.shadowRoot);
        this.topLayerHosts.delete(hostEl);
        rec = null;
      }
      if (!rec) {
        const container = document.createElement('div');
        container.className = 'sps-tl-container' +
          (this.presentMode && this.presentOpaque !== false ? ' sps-present' : '') +
          (this._pmLocked ? ' sps-locked' : '');
        container.style.cssText =
          'position:fixed;top:0;left:0;width:0;height:0;overflow:visible;' +
          'pointer-events:none;z-index:2147483647;';
        const sr = container.attachShadow({ mode: 'open' });
        const st = document.createElement('style');
        st.textContent = this.cssText || '';
        sr.appendChild(st);
        try {
          hostEl.appendChild(container);
        } catch (e) {
          return this.shadowRoot;
        }
        rec = { container, shadowRoot: sr, styleElement: st };
        this.topLayerHosts.set(hostEl, rec);
        if (this.presentMode) {
          this.showRibbon();
          if (this._watermarkOn) this.showWatermark();
        }
      }
      return rec.shadowRoot;
    }

    /** Resolve which top-layer host (if any) a record's source belongs to. */
    resolveHostForRecord(record) {
      let el = null;
      if (record.type === 'TEXT_RANGE') {
        el = record.node && (record.node.parentElement || record.node.parentNode);
      } else if (record.type === 'ELEMENT') {
        el = record.element;
      } else if (record.type === 'OCR_BOX') {
        el = record.targetElement;
      }
      return el ? this.resolveContext(el) : null;
    }

    /**
     * If a record's content moved into/out of a top-layer host since the
     * overlay was built, migrate its rect elements to the correct shadow root
     * and flip the coordinate space (fixed vs document).
     */
    migrateIfNeeded(record) {
      const targetHost = this.resolveHostForRecord(record) || null;
      if (targetHost === (record.hostEl || null)) return;
      const sr = this.getShadowRootForContext(targetHost);
      for (const el of record.rectEls) {
        if (el.parentNode !== sr) sr.appendChild(el);
        el.classList.toggle('sps-fixed', !!(targetHost || record.isFixed));
      }
      record.hostEl = targetHost;
    }

    /** Remove shadow containers whose top-layer host closed/disconnected. */
    pruneTopLayerHosts() {
      for (const [hostEl, rec] of this.topLayerHosts) {
        const valid = hostEl.isConnected && (
          hostEl === document.fullscreenElement ||
          (hostEl.tagName === 'DIALOG' && hostEl.open) ||
          (hostEl.matches && hostEl.matches(':popover-open'))
        );
        if (!valid) {
          rec.container.remove();
          this.shadowUI.delete(rec.shadowRoot);
          this.topLayerHosts.delete(hostEl);
        }
      }
    }

    // ---------------------------------------------------------------
    // Listeners: scroll (capture), resize, viewport, top-layer
    // ---------------------------------------------------------------

    initListeners() {
      const scheduleSync = () => {
        if (this.rafPending) return;
        this.rafPending = true;
        requestAnimationFrame(() => {
          this.syncOverlayPositions();
          this.rafPending = false;
        });
      };
      this._scheduleSync = scheduleSync;

      // Document-level scrolls need NO per-frame work: absolute overlays
      // live inside the document and move natively with it, fixed overlays
      // stay viewport-anchored. A debounced settle sync catches
      // position:sticky content and any residual drift. Nested scroll
      // containers DO change document coordinates -> sync next frame.
      let settleTimer = null;
      const settleSync = () => {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => { settleTimer = null; scheduleSync(); }, 120);
      };

      window.addEventListener('resize', scheduleSync, { passive: true });
      window.addEventListener('orientationchange', scheduleSync, { passive: true });
      // Capture phase: scroll events do NOT bubble - capture catches scrolls
      // inside nested overflow containers, which is where real apps scroll.
      window.addEventListener('scroll', (e) => {
        const t = e.target;
        if (t === document || t === document.documentElement ||
            t === document.body || !t || t.nodeType !== Node.ELEMENT_NODE) {
          settleSync();
          // position:sticky content moves relative to the document while
          // the page scrolls - re-glue those overlays live, not at settle.
          if (this.stickyRecords.size) this.scheduleStickySync();
        } else {
          scheduleSync();
        }
      }, { passive: true, capture: true });

      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleSync, { passive: true });
        window.visualViewport.addEventListener('scroll', scheduleSync, { passive: true });
      }

      // Top-layer transitions
      document.addEventListener('fullscreenchange', () => {
        this.mountContainer();
        scheduleSync();
      });
      // Popovers fire 'toggle' on themselves - capture catches them all.
      document.addEventListener('toggle', (e) => {
        if (e.target && e.target.matches &&
            (e.target.matches('[popover]') || e.target.tagName === 'DIALOG')) {
          scheduleSync();
        }
      }, { passive: true, capture: true });
      // Modal <dialog> open state via attribute
      const dlgObs = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === 'attributes' && m.attributeName === 'open') {
            scheduleSync();
          }
        }
      });
      const obsRoot = document.documentElement;
      if (obsRoot) {
        dlgObs.observe(obsRoot, {
          attributes: true, attributeFilter: ['open'], subtree: true
        });
      }

      // Safety sweep: CSS animations, transforms and other layout shifts that
      // no observer can see still get overlays re-glued at low frequency.
      this.sweepTimer = setInterval(() => {
        if (this.overlays.size && !document.hidden) scheduleSync();
      }, 2500);
    }

    /** External trigger for position sync (e.g. after DOM mutations). */
    requestSync() {
      if (this._scheduleSync) this._scheduleSync();
    }

    /**
     * Run `fn` with pointer hit-testing disabled on EVERY overlay layer
     * (main + all top-layer shadows). Used to retarget clicks/context
     * menus to the real element under a chip - chips are visual masks,
     * not interactive surfaces for normal clicks.
     */
    withHitTestDisabled(fn) {
      const hosts = [this.container];
      for (const [, rec] of this.topLayerHosts) hosts.push(rec.container);
      const touched = [];
      for (const h of hosts) {
        if (h && !h.classList.contains('sps-hit-off')) {
          h.classList.add('sps-hit-off');
          touched.push(h);
        }
      }
      try {
        return fn();
      } finally {
        for (const h of touched) h.classList.remove('sps-hit-off');
      }
    }

    /** True for our own container elements / anything inside them. */
    isOwnElement(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      if (el.id === CONTAINER_ID ||
          (el.classList && el.classList.contains('sps-tl-container'))) return true;
      return !!(el.closest &&
        el.closest('#' + CONTAINER_ID + ', .sps-tl-container'));
    }

    /**
     * Live re-glue of overlays anchored to position:sticky content during
     * document scroll. Cheap: only the flagged records re-measure; the
     * host rect is re-read once per pass (it moves every scroll frame, so
     * the 16ms measureHostRect cache must be invalidated first).
     */
    scheduleStickySync() {
      if (this._stickyRaf) return;
      this._stickyRaf = true;
      requestAnimationFrame(() => {
        this._stickyRaf = false;
        this._hostRect = null; // stale during scroll - force fresh read
        for (const id of this.stickyRecords) {
          const rec = this.overlays.get(id);
          if (rec) this.updateSinglePosition(rec, undefined, true);
        }
      });
    }

    // ---------------------------------------------------------------
    // Overlay element creation
    // ---------------------------------------------------------------

    createRectElement(id, meta, isPrimary) {
      const el = document.createElement('div');
      el.className = 'sps-blur-overlay';
      if (isPrimary) el.id = `sps-overlay-${id}`;

      // Category accent: solid for badges/hover, 45% alpha for the idle
      // border - the chip outline itself signals the PII category.
      if (meta.color) {
        el.style.setProperty('--sps-accent', meta.color);
        const soft = OverlayManager.hexToRgba(meta.color, 0.45);
        if (soft) el.style.setProperty('--sps-accent-soft', soft);
      }

      if (isPrimary) {
        const badge = document.createElement('div');
        badge.className = 'sps-badge';
        if (meta.color) badge.style.setProperty('--sps-accent', meta.color);
        const badgeText = document.createElement('span');
        badgeText.className = 'sps-badge-text';
        badgeText.textContent = meta.badge || '🔒 REDACTED';
        badge.appendChild(badgeText);
        el.appendChild(badge);

        const shimmer = document.createElement('div');
        shimmer.className = 'sps-shimmer';
        el.appendChild(shimmer);

        const tooltip = document.createElement('div');
        tooltip.className = 'sps-tooltip';
        tooltip.textContent = '⌥ Alt+Click to pin-reveal · Esc re-covers';
        el.appendChild(tooltip);
      }
      return el;
    }

    /** Build rect elements + group wiring for a record. */
    buildOverlayGroup(id, meta, rectCount, hostEl, fixed) {
      const sr = this.getShadowRootForContext(hostEl);
      const rectEls = [];
      for (let i = 0; i < rectCount; i++) {
        const el = this.createRectElement(id, meta, i === 0);
        el.__spsMeta = meta;
        if (hostEl || fixed) el.classList.add('sps-fixed');
        rectEls.push(el);
        sr.appendChild(el);
      }
      // Group link: hover/reveal applies to every rect of the same match
      for (const el of rectEls) el.__spsGroup = rectEls;

      if (this.hoverController) {
        this.hoverController.attachToOverlay(rectEls[0], meta);
        for (let i = 1; i < rectEls.length; i++) {
          this.hoverController.attachToOverlay(rectEls[i], meta);
        }
      }
      return rectEls;
    }

    /**
     * Merge rects that share (roughly) the same line and are horizontally
     * adjacent - reduces element count for long wrapped matches.
     */
    static hexToRgba(hex, alpha) {
      const m = /^#?([0-9a-f]{3,8})$/i.exec(hex || '');
      if (!m) return null;
      let h = m[1];
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      if (h.length < 6) return null;
      const n = parseInt(h.slice(0, 6), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    }

    static mergeAdjacentRects(rects) {
      const out = [];
      const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
      for (const r of sorted) {
        const last = out[out.length - 1];
        if (last &&
            Math.abs(r.top - last.top) < 4 &&
            r.left <= last.right + 8 &&
            r.bottom <= last.bottom + 4) {
          last.right = Math.max(last.right, r.right);
          last.width = last.right - last.left;
          last.bottom = Math.max(last.bottom, r.bottom);
          last.height = last.bottom - last.top;
        } else {
          // NOTE: cannot use { ...r } - DOMRect fields are prototype
          // getters, so spread produces an empty object in real Chrome.
          out.push({
            top: r.top, left: r.left, width: r.width, height: r.height,
            right: r.left + r.width, bottom: r.top + r.height
          });
        }
      }
      return out;
    }

    addRangeOverlay(range, meta) {
      if (this.overlays.size >= this.maxOverlays) {
        this.overflowCount++;
        this.updateOverflowBadge();
        return null;
      }

      const id = 'rng_' + Math.random().toString(36).substring(2, 9);
      meta.id = id;
      meta.nodeHash = hashString(meta.value || '');

      let rects = [];
      try {
        rects = Array.from(range.getClientRects());
      } catch (e) {
        rects = [];
      }
      rects = rects.filter(r => r.width > 2 && r.height > 2);
      if (rects.length === 0) {
        const b = range.getBoundingClientRect();
        if (b.width > 0 && b.height > 0) rects = [b];
      }
      rects = OverlayManager.mergeAdjacentRects(rects);
      if (rects.length === 0) return null;

      const hostEl = this.resolveContext(range.startContainer);
      // Ranges inside position:fixed ancestors keep viewport-stable rects
      // while the page scrolls - they must use fixed overlays, just like
      // element records, or they drift off their text. Sticky ancestors
      // need live re-gluing during document scroll.
      const parentEl = range.startContainer &&
        (range.startContainer.parentElement || range.startContainer.parentNode);
      const pos = parentEl ? this.detectPositioning(parentEl) : { fixed: false, sticky: false };
      const rectEls = this.buildOverlayGroup(id, meta, rects.length, hostEl, pos.fixed);
      const record = {
        id, type: 'TEXT_RANGE', range,
        node: range.startContainer, hostEl, isFixed: pos.fixed,
        isSticky: pos.sticky && !pos.fixed,
        overlayEl: rectEls[0], rectEls, meta
      };
      this.overlays.set(id, record);
      this.indexRecord(record);
      this.updateSinglePosition(record, rects);
      return id;
    }

    addElementOverlay(element, meta) {
      for (const [, rec] of this.overlays) {
        if (rec.type === 'ELEMENT' && rec.element === element) return rec.id;
      }
      if (this.overlays.size >= this.maxOverlays) {
        this.overflowCount++;
        this.updateOverflowBadge();
        return null;
      }

      const id = 'el_' + Math.random().toString(36).substring(2, 9);
      meta.id = id;
      meta.nodeHash = hashString(element.innerText || element.value || '');

      const hostEl = this.resolveContext(element);
      const pos = this.detectPositioning(element);
      const rectEls = this.buildOverlayGroup(id, meta, 1, hostEl, pos.fixed);
      const record = {
        id, type: 'ELEMENT', element, hostEl,
        isFixed: pos.fixed, isSticky: pos.sticky && !pos.fixed,
        overlayEl: rectEls[0], rectEls, meta
      };
      // Leaf elements can't contain fixed-position descendants, so a
      // filter:blur() on the element itself is safe and free. Applies to
      // any ELEMENT overlay on a childless tag (fields, images, canvases,
      // leaf selector-rule targets).
      const t = element.tagName;
      if (meta.directBlur !== false &&
          (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' ||
           t === 'IMG' || t === 'CANVAS')) {
        record.directBlurEl = element;
        for (const e of rectEls) e.classList.add('sps-leaf-mask');
        this.applyElementMask(element);
      }
      this.overlays.set(id, record);
      this.indexRecord(record);
      this.coveredElements.set(element, record);
      this.updateSinglePosition(record);
      return id;
    }

    /**
     * True when `el` is fully covered by an ELEMENT overlay that is not
     * currently revealed. The scanner uses this to skip descending into
     * covered containers (their chips would be invisible anyway).
     */
    isElementCovered(el) {
      const rec = this.coveredElements.get(el);
      if (!rec) return false;
      const primary = rec.rectEls && rec.rectEls[0];
      return !(primary && primary.classList.contains('sps-revealed'));
    }

    /**
     * ocrBox is NORMALIZED: {x0,y0,x1,y1,srcW,srcH} where the x/y coords
     * are source-pixel coordinates and srcW/srcH are the raster dimensions.
     * Storing source dims means the box rescales live when the element is
     * resized (PDF zoom, responsive canvases) - the sync path multiplies
     * by the element's current rendered size.
     */
    addOcrOverlay(targetElement, ocrBox, meta) {
      if (this.overlays.size >= this.maxOverlays) {
        this.overflowCount++;
        this.updateOverflowBadge();
        return null;
      }

      const id = 'ocr_' + Math.random().toString(36).substring(2, 9);
      meta.id = id;
      meta.nodeHash = hashString(meta.value || '');

      const hostEl = this.resolveContext(targetElement);
      const pos = this.detectPositioning(targetElement);
      const rectEls = this.buildOverlayGroup(id, meta, 1, hostEl, pos.fixed);
      const record = {
        id, type: 'OCR_BOX', targetElement, ocrBox, hostEl, isFixed: pos.fixed,
        isSticky: pos.sticky && !pos.fixed,
        overlayEl: rectEls[0], rectEls, meta
      };
      this.overlays.set(id, record);
      this.indexRecord(record);
      this.updateSinglePosition(record);
      return id;
    }

    /** Register a record in the reverse indexes + sticky tracking set. */
    indexRecord(record) {
      if (record.node) {
        let s = this.nodeRecords.get(record.node);
        if (!s) { s = new Set(); this.nodeRecords.set(record.node, s); }
        s.add(record.id);
      }
      const keyEl = record.element || record.targetElement;
      if (keyEl) {
        let s = this.elementRecords.get(keyEl);
        if (!s) { s = new Set(); this.elementRecords.set(keyEl, s); }
        s.add(record.id);
      }
      if (record.isSticky) this.stickyRecords.add(record.id);
    }

    unindexRecord(record) {
      if (record.node) {
        const s = this.nodeRecords.get(record.node);
        if (s) { s.delete(record.id); if (!s.size) this.nodeRecords.delete(record.node); }
      }
      const keyEl = record.element || record.targetElement;
      if (keyEl) {
        const s = this.elementRecords.get(keyEl);
        if (s) { s.delete(record.id); if (!s.size) this.elementRecords.delete(keyEl); }
      }
      this.stickyRecords.delete(record.id);
    }

    isInsideFixed(el) {
      return this.detectPositioning(el).fixed;
    }

    /**
     * Single ancestor walk returning which special positioning contexts
     * apply: 'fixed' (viewport-anchored always) and 'sticky' (viewport-
     * anchored only while stuck - moves vs the document during scroll).
     */
    detectPositioning(el) {
      let cur = el;
      let hops = 0;
      let fixed = false, sticky = false;
      while (cur && hops < 6 && !(fixed && sticky)) {
        try {
          if (cur.nodeType === Node.ELEMENT_NODE) {
            const p = window.getComputedStyle(cur).position;
            if (p === 'fixed') fixed = true;
            else if (p === 'sticky') sticky = true;
          }
        } catch (e) {}
        cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
        hops++;
      }
      return { fixed, sticky };
    }

    // ---------------------------------------------------------------
    // Positioning
    // ---------------------------------------------------------------

    updateSinglePosition(record, precomputedRects, skipSync) {
      // Stale-record guard: prevents ghost chips if called on a record
      // that was already removed (e.g. detached rAF callbacks).
      if (this.overlays.get(record.id) !== record) return;
      const type = record.type;
      if (!record.rectEls) record.rectEls = [];
      const { rectEls } = record;

      this.migrateIfNeeded(record);

      let rects = [];

      if (type === 'TEXT_RANGE') {
        if (!record.range || !record.node || record.node.isConnected === false) {
          this.removeOverlay(record.id);
          return;
        }
        rects = precomputedRects || Array.from(record.range.getClientRects())
          .filter(r => r.width > 2 && r.height > 2);
        rects = OverlayManager.mergeAdjacentRects(rects);
      } else if (type === 'ELEMENT') {
        if (!record.element || record.element.isConnected === false) {
          this.removeOverlay(record.id);
          return;
        }
        const b = record.element.getBoundingClientRect();
        rects = [{ top: b.top, left: b.left, width: b.width, height: b.height }];
      } else if (type === 'OCR_BOX') {
        if (!record.targetElement || record.targetElement.isConnected === false) {
          this.removeOverlay(record.id);
          return;
        }
        const baseRect = record.targetElement.getBoundingClientRect();
        const box = record.ocrBox;
        // Source-pixel box rescaled to the element's CURRENT rendered size
        const sx = baseRect.width / (box.srcW || 1);
        const sy = baseRect.height / (box.srcH || 1);
        rects = [{
          top: baseRect.top + box.y0 * sy,
          left: baseRect.left + box.x0 * sx,
          width: (box.x1 - box.x0) * sx,
          height: (box.y1 - box.y0) * sy
        }];
      }

      // Top-layer hosted overlays use viewport coords (position:fixed).
      // Document-hosted overlays are position:absolute inside the container:
      // their coordinates are rect.minus(container's own viewport rect).
      // Measuring the container (instead of assuming document origin +
      // scroll offset) is robust against positioned ancestors on
      // body/html and any margins - a shifted containing block would
      // otherwise misalign every overlay.
      const fixed = record.isFixed === true || !!record.hostEl;
      let hostTop = 0, hostLeft = 0;
      if (!fixed) {
        const hb = this.measureHostRect();
        hostTop = hb.top;
        hostLeft = hb.left;
      }

      // Ensure rect element count matches rect data count
      const shadow = this.getShadowRootForContext(record.hostEl);
      while (rectEls.length < rects.length) {
        // After a container remount the PRIMARY chip may be gone - the
        // first rebuilt rect must regain the badge (and leaf-mask class
        // for direct-blur records) or the overlay loses its label.
        const el = this.createRectElement(record.id, record.meta, rectEls.length === 0);
        el.__spsMeta = record.meta;
        if (record.hostEl || record.isFixed) el.classList.add('sps-fixed');
        if (record.directBlurEl) el.classList.add('sps-leaf-mask');
        rectEls.push(el);
        for (const e of rectEls) e.__spsGroup = rectEls;
        if (this.hoverController) this.hoverController.attachToOverlay(el, record.meta);
        shadow.appendChild(el);
      }

      for (let i = 0; i < rectEls.length; i++) {
        const el = rectEls[i];
        const rect = rects[i];

        if (!rect || (rect.width === 0 && rect.height === 0)) {
          el.style.display = 'none';
          continue;
        }

        // Negative coordinates are legitimate: offscreen drawers, content
        // in horizontally-scrolled panes, and sticky/fixed elements above
        // the viewport fold all produce them. Clamping to 0 would clamp
        // the chip onto WRONG visible content - only bound for sanity.
        const top = Math.max(-8192, Math.round(rect.top - hostTop - RECT_PAD));
        const left = Math.max(-8192, Math.round(rect.left - hostLeft - RECT_PAD));
        const width = Math.round(rect.width + RECT_PAD * 2);
        const height = Math.round(rect.height + RECT_PAD * 2);

        el.style.display = 'inline-flex';
        // GPU-composited positioning: transform avoids the layout work
        // that top/left writes trigger on every scroll frame.
        el.style.transform = `translate(${left}px, ${top}px)`;
        el.style.width = `${width}px`;
        el.style.height = `${height}px`;

        if (width < 60 || height < 18) el.classList.add('sps-compact');
        else el.classList.remove('sps-compact');
      }

      if (!skipSync) this.requestSync();
    }

    /**
     * Direct element masking: leaf elements (input/textarea/select/img)
     * are blurred with filter:blur() on the element itself - the cheapest
     * possible redaction (no backdrop-filter pass at all). The overlay
     * chip still renders border + badge on top.
     * Chromium cannot region-clip backdrop-filter (clip-path/mask on any
     * ancestor or the element itself do not bound the filtered backdrop),
     * so a single shared blur layer is impossible - direct element blur
     * is the fastest correct alternative for childless elements.
     * Called from the batched sync; idempotent, O(masked elements).
     */
    syncElementMasks() {
      const locked = this._pmLocked;
      for (const [, rec] of this.overlays) {
        const el = rec.directBlurEl;
        if (!el) continue;
        if (!el.isConnected) { this.restoreElementMask(el); continue; }
        const revealed = rec.rectEls && rec.rectEls[0] &&
          rec.rectEls[0].classList.contains('sps-revealed');
        if (revealed && !locked) this.restoreElementMask(el);
        else this.applyElementMask(el);
      }
    }

    applyElementMask(el) {
      if (!this.maskedElements.has(el)) {
        this.maskedElements.set(el, el.style.filter || '');
      }
      const cur = el.style.filter || '';
      if (cur.indexOf('blur(') === -1) {
        const orig = this.maskedElements.get(el);
        const px = Math.max(4, (this.blurIntensity || 8) - 2);
        el.style.filter = (`blur(${px}px) ` + orig).trim();
      }
    }

    restoreElementMask(el) {
      const orig = this.maskedElements.get(el);
      if (orig === undefined) return;
      el.style.filter = orig;
      this.maskedElements.delete(el);
    }

    /** Called by the hover controller after reveal/re-blur class changes. */
    refreshMasks() {
      this.syncElementMasks();
    }

    /**
     * Measure the overlay container's viewport rect, cached for one frame
     * (~16ms). Overlay writes themselves dirty layout - without the cache a
     * burst of addRangeOverlay calls would force a synchronous layout per
     * overlay. The container only moves on remount/scroll, which the
     * position sweep re-measures every frame anyway.
     */
    measureHostRect() {
      if (!this.container) return { top: 0, left: 0 };
      const now = performance.now();
      if (!this._hostRect || now - this._hostRectAt > 16) {
        this._hostRect = this.container.getBoundingClientRect();
        this._hostRectAt = now;
      }
      return this._hostRect;
    }

    /**
     * Two-phase batched sync: read every rect first, then write every style.
     * Avoids layout thrashing when there are many overlays.
     */
    syncOverlayPositions() {
      if (this.overlays.size === 0 || !this.container) return;

      // Keep container inside the active top-layer element
      if (document.fullscreenElement &&
          this.container.parentNode !== document.fullscreenElement) {
        this.mountContainer();
      }

      const dead = [];
      const updates = [];

      // Phase 1: reads only
      for (const [id, record] of this.overlays) {
        const { type } = record;
        if (!record.rectEls) record.rectEls = [];
        const { rectEls } = record;

        this.migrateIfNeeded(record);

        if (type === 'TEXT_RANGE') {
          if (!record.node || record.node.isConnected === false) { dead.push(id); continue; }
          let rects;
          try {
            rects = Array.from(record.range.getClientRects())
              .filter(r => r.width > 2 && r.height > 2);
          } catch (e) { rects = []; }
          updates.push({ record, rects: OverlayManager.mergeAdjacentRects(rects) });
        } else if (type === 'ELEMENT') {
          if (!record.element || record.element.isConnected === false) { dead.push(id); continue; }
          const b = record.element.getBoundingClientRect();
          updates.push({ record, rects: [{ top: b.top, left: b.left, width: b.width, height: b.height }] });
        } else if (type === 'OCR_BOX') {
          if (!record.targetElement || record.targetElement.isConnected === false) { dead.push(id); continue; }
          const baseRect = record.targetElement.getBoundingClientRect();
          const box = record.ocrBox;
          const sx = baseRect.width / (box.srcW || 1);
          const sy = baseRect.height / (box.srcH || 1);
          updates.push({
            record,
            rects: [{
              top: baseRect.top + box.y0 * sy,
              left: baseRect.left + box.x0 * sx,
              width: (box.x1 - box.x0) * sx,
              height: (box.y1 - box.y0) * sy
            }]
          });
        }
      }

      for (const id of dead) this.removeOverlay(id);

      // Phase 2: writes only. Absolute (non-fixed) overlays position
      // relative to the container's own viewport rect - always measured
      // fresh here (the authoritative sync), then shared with burst adds.
      const hostRect = this.container.getBoundingClientRect();
      this._hostRect = hostRect;
      this._hostRectAt = performance.now();
      const hostTop = hostRect.top;
      const hostLeft = hostRect.left;

      for (const { record, rects } of updates) {
        const { rectEls } = record;
        const fixed = record.isFixed === true || !!record.hostEl;
        const shadow = this.getShadowRootForContext(record.hostEl);

        while (rectEls.length < rects.length) {
          const el = this.createRectElement(record.id, record.meta, rectEls.length === 0);
          el.__spsMeta = record.meta;
          if (record.hostEl || record.isFixed) el.classList.add('sps-fixed');
          if (record.directBlurEl) el.classList.add('sps-leaf-mask');
          rectEls.push(el);
          for (const e of rectEls) e.__spsGroup = rectEls;
          if (this.hoverController) this.hoverController.attachToOverlay(el, record.meta);
          shadow.appendChild(el);
        }

        for (let i = 0; i < rectEls.length; i++) {
          const el = rectEls[i];
          const rect = rects[i];
          if (!rect || (rect.width === 0 && rect.height === 0)) {
            if (el.style.display !== 'none') el.style.display = 'none';
            continue;
          }
          const top = Math.max(-8192, Math.round(rect.top - (fixed ? 0 : hostTop) - RECT_PAD));
          const left = Math.max(-8192, Math.round(rect.left - (fixed ? 0 : hostLeft) - RECT_PAD));
          const width = Math.round(rect.width + RECT_PAD * 2);
          const height = Math.round(rect.height + RECT_PAD * 2);

          if (el.style.display !== 'inline-flex') el.style.display = 'inline-flex';
          el.style.transform = `translate(${left}px, ${top}px)`;
          el.style.width = `${width}px`;
          el.style.height = `${height}px`;

          const compact = width < 60 || height < 18;
          if (compact) el.classList.add('sps-compact');
          else el.classList.remove('sps-compact');
        }
      }

      this.syncElementMasks();
      this.pruneTopLayerHosts();
    }

    // ---------------------------------------------------------------
    // Overflow badge
    // ---------------------------------------------------------------

    updateOverflowBadge() {
      if (!this.overflowBadgeEl) {
        this.overflowBadgeEl = document.createElement('div');
        this.overflowBadgeEl.className = 'sps-overflow-badge';
        this.shadowRoot.appendChild(this.overflowBadgeEl);
      }
      this.overflowBadgeEl.textContent = `🔒 +${this.overflowCount} more redacted`;
      this.overflowBadgeEl.style.display = 'block';
    }

    // ---------------------------------------------------------------
    // Present Mode: opaque bars + watermark + ribbon
    // ---------------------------------------------------------------

    setPresentMode(active, opts = {}) {
      this.presentMode = !!active;
      if (opts.watermarkText !== undefined) this.watermarkText = opts.watermarkText;
      if (opts.opaque !== undefined) this.presentOpaque = !!opts.opaque;

      // 'sps-present' = opaque hard-redaction styling (optional - PM can also
      // run with normal blurs when opaque is disabled).
      // 'sps-locked'  = hover reveal is locked out (unless allowReveal).
      const hardRedact = this.presentMode && this.presentOpaque !== false;
      const locked = this.presentMode && opts.allowReveal !== true;
      this._pmLocked = locked;

      if (this.container) {
        this.container.classList.toggle('sps-present', hardRedact);
        this.container.classList.toggle('sps-locked', locked);
      }
      this.forEachTopLayerShadow(rec => {
        rec.container.classList.toggle('sps-present', hardRedact);
        rec.container.classList.toggle('sps-locked', locked);
      });
      if (this.presentMode) {
        if (opts.watermarkEnabled !== false) {
          this._watermarkOn = true;
          this.showWatermark();
        }
        this.showRibbon();
      } else {
        this._watermarkOn = false;
        this.hideWatermark();
        this.hideRibbon();
      }
      if (this.hoverController && this.hoverController.setPresentMode) {
        this.hoverController.setPresentMode(locked);
      }
      this.syncElementMasks();
    }

    showRibbon() {
      this.forEachShadow(sr => {
        const ui = this.uiFor(sr);
        if (!ui.ribbon) {
          ui.ribbon = document.createElement('div');
          ui.ribbon.className = 'sps-ribbon';
          sr.appendChild(ui.ribbon);
        }
        ui.ribbon.textContent = '● SCREENSHIELD — PRESENT MODE';
        ui.ribbon.style.display = 'flex';
      });
    }

    hideRibbon() {
      this.forEachShadow(sr => {
        const ui = this.shadowUI.get(sr);
        if (ui && ui.ribbon) ui.ribbon.style.display = 'none';
      });
    }

    showWatermark() {
      const text = (this.watermarkText ||
        `${location.hostname} • ${new Date().toISOString().slice(0, 10)}`).toUpperCase();
      const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='300'>` +
        `<text x='20' y='150' transform='rotate(-24 210 150)' ` +
        `font-family='monospace' font-size='22' fill='%23ffffff' ` +
        `fill-opacity='0.55'>PROTECTED • ${this.escapeXml(text)}</text></svg>`;
      const bg = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
      this.forEachShadow(sr => {
        const ui = this.uiFor(sr);
        if (!ui.watermark) {
          ui.watermark = document.createElement('div');
          ui.watermark.className = 'sps-watermark';
          sr.appendChild(ui.watermark);
        }
        ui.watermark.style.backgroundImage = bg;
        ui.watermark.style.display = 'block';
      });
    }

    hideWatermark() {
      this.forEachShadow(sr => {
        const ui = this.shadowUI.get(sr);
        if (ui && ui.watermark) ui.watermark.style.display = 'none';
      });
    }

    // ---------------------------------------------------------------
    // Interactive toasts (suggestions / notices)
    // ---------------------------------------------------------------

    /** Small transient notice (context-menu feedback). Auto-dismisses. */
    showNoticeToast(text, ms = 3500) {
      const t = document.createElement('div');
      t.className = 'sps-notice';
      t.textContent = '🛡️ ' + text;
      this.shadowRoot.appendChild(t);
      setTimeout(() => t.remove(), ms);
    }

    /**
     * Meeting-site suggestion: "Turn on Present Mode?" with accept/dismiss.
     * One at a time; auto-hides after 25s.
     */
    showPmSuggestion(onAccept) {
      if (this._suggestEl) return;
      const wrap = document.createElement('div');
      wrap.className = 'sps-suggest';

      const label = document.createElement('span');
      label.className = 'sps-suggest-text';
      label.textContent = '🎥 Meeting site detected - enable Present Mode to hide sensitive data while sharing?';

      const yes = document.createElement('button');
      yes.className = 'sps-suggest-btn sps-suggest-yes';
      yes.textContent = 'Enable';
      yes.addEventListener('click', () => {
        this.hidePmSuggestion();
        if (typeof onAccept === 'function') onAccept();
      });

      const no = document.createElement('button');
      no.className = 'sps-suggest-btn sps-suggest-no';
      no.textContent = 'Later';
      no.addEventListener('click', () => this.hidePmSuggestion());

      wrap.appendChild(label);
      wrap.appendChild(yes);
      wrap.appendChild(no);
      this.shadowRoot.appendChild(wrap);
      this._suggestEl = wrap;
      this._suggestTimer = setTimeout(() => this.hidePmSuggestion(), 25000);
    }

    hidePmSuggestion() {
      if (this._suggestTimer) { clearTimeout(this._suggestTimer); this._suggestTimer = null; }
      if (this._suggestEl) { this._suggestEl.remove(); this._suggestEl = null; }
    }

    escapeXml(s) {
      return String(s).replace(/[<>&'"]/g, c => ({
        '<': '&lt;', '>': '&amp;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
      })[c]);
    }

    // ---------------------------------------------------------------
    // Removal
    // ---------------------------------------------------------------

    removeOverlay(id) {
      const rec = this.overlays.get(id);
      if (!rec) return;
      const els = rec.rectEls || (rec.overlayEl ? [rec.overlayEl] : []);
      for (const el of els) {
        if (el && el.parentNode) el.remove();
      }
      if (rec.directBlurEl) this.restoreElementMask(rec.directBlurEl);
      if (rec.element) {
        this.coveredElements.delete(rec.element);
        // The uncovered subtree may hold text that was never scanned
        // (descent was skipped while covered) - let the scanner re-walk it.
        if (this.onElementUnmasked && !this._clearing) {
          try { this.onElementUnmasked(rec.element); } catch (e) {}
        }
      }
      this.unindexRecord(rec);
      this.overlays.delete(id);
      this.requestSync();
    }

    removeOverlaysForNode(node) {
      const ids = this.nodeRecords.get(node);
      if (!ids) return;
      for (const id of [...ids]) this.removeOverlay(id);
    }

    /**
     * Remove overlays keyed to an element. `type` scopes the removal:
     * ocr_detector passes 'OCR_BOX' so a canvas re-scan drops OCR chips
     * without wiping ELEMENT overlays (e.g. a user's selector rule on
     * the same canvas).
     */
    removeOverlaysForElement(element, type) {
      const ids = this.elementRecords.get(element);
      if (!ids) return;
      for (const id of [...ids]) {
        const rec = this.overlays.get(id);
        if (rec && (!type || rec.type === type)) this.removeOverlay(id);
      }
    }

    clearAll() {
      this._clearing = true;
      for (const [, rec] of this.overlays) {
        const els = rec.rectEls || (rec.overlayEl ? [rec.overlayEl] : []);
        for (const el of els) {
          if (el && el.parentNode) el.remove();
        }
      }
      this.overlays.clear();
      this.coveredElements = new WeakMap();
      this.nodeRecords = new WeakMap();
      this.elementRecords = new WeakMap();
      this.stickyRecords.clear();
      this._clearing = false;
      this.overflowCount = 0;
      if (this.overflowBadgeEl) this.overflowBadgeEl.style.display = 'none';
      for (const el of [...this.maskedElements.keys()]) {
        this.restoreElementMask(el);
      }
    }

    getActiveCount() {
      return this.overlays.size;
    }

    destroy() {
      if (this.selfHealObserver) this.selfHealObserver.disconnect();
      if (this.sweepTimer) clearInterval(this.sweepTimer);
      this.clearAll();
      this.forEachTopLayerShadow(rec => rec.container.remove());
      this.topLayerHosts.clear();
      this.shadowUI.clear();
      if (this.container && this.container.parentNode) this.container.remove();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { OverlayManager, hashString };
  } else {
    global.ScreenShieldOverlayManager = OverlayManager;
  }
})(typeof window !== 'undefined' ? window : globalThis);
