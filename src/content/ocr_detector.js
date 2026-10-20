/**
 * Screen Privacy Shield - On-Device Image & Canvas OCR Detector
 * Extracts pixel data from <img> tags and same-origin <canvas> elements
 * (including PDF.js per-page canvases). OCR runs inside the offscreen
 * document via the bundled Tesseract.js worker - 100% offline.
 *
 * Canvases that repaint (PDF scroll, dashboards) are re-scanned when they
 * re-enter the viewport after a staleness window.
 */

(function (global) {
  'use strict';

  const RESCAN_STALE_MS = 10000; // re-OCR canvases re-seen after 10s
  const MIN_CANVAS_W = 50;
  const MIN_CANVAS_H = 20;

  class OcrDetector {
    constructor(options = {}) {
      this.regexEngine = options.regexEngine;
      this.overlayManager = options.overlayManager;
      this.onDetection = options.onDetection || (() => {});
      this.enabled = !!options.enabled;
      this.isProcessing = false;

      // element -> last processed timestamp (re-processable after staleness)
      this.processedElements = new WeakMap();
      this.inFlight = new WeakSet();
      this.inViewport = new WeakSet();

      this.initMediaObserver();
    }

    setEnabled(val) {
      this.enabled = !!val;
      if (this.enabled) {
        // Kick a scan when re-enabled at runtime
        this.scanMediaElements();
      }
    }

    /**
     * Observe media elements so repainted canvases get re-checked when they
     * come back into view.
     */
    initMediaObserver() {
      if (typeof IntersectionObserver === 'undefined') return;
      this.mediaObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.inViewport.add(entry.target);
            const last = this.processedElements.get(entry.target);
            if (last && (Date.now() - last) > RESCAN_STALE_MS) {
              // Re-entered viewport and stale -> reprocess
              this.processedElements.delete(entry.target);
              if (entry.target.tagName === 'CANVAS') {
                this.processCanvas(entry.target);
              } else if (entry.target.tagName === 'IMG') {
                this.processImage(entry.target);
              }
            }
          } else {
            this.inViewport.delete(entry.target);
          }
        }
      }, { rootMargin: '100px', threshold: 0.05 });
    }

    /**
     * Test whether a canvas is tainted by cross-origin images
     */
    isTainted(canvas) {
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) return false;
        ctx.getImageData(0, 0, 1, 1);
        return false;
      } catch (e) {
        return true;
      }
    }

    /**
     * Process all visible images and canvases in a container
     */
    async scanMediaElements(root = document.body) {
      if (!this.enabled || !root || !root.querySelectorAll) return;

      const canvases = root.querySelectorAll('canvas');
      for (const canvas of canvases) {
        this.observeMedia(canvas);
        if (!this.processedElements.has(canvas)) {
          await this.processCanvas(canvas);
        }
      }

      const images = root.querySelectorAll('img');
      for (const img of images) {
        this.observeMedia(img);
        if (!this.processedElements.has(img)) {
          await this.processImage(img);
        }
      }
    }

    observeMedia(el) {
      if (this.mediaObserver && el && el.isConnected) {
        try { this.mediaObserver.observe(el); } catch (e) {}
      }
      // Images still loading at scan time: OCR them once they complete.
      if (el && el.tagName === 'IMG' && !el.complete && !el.__spsLoadWatched) {
        el.__spsLoadWatched = true;
        el.addEventListener('load', () => {
          if (this.enabled && !this.processedElements.has(el)) {
            this.processImage(el);
          }
        }, { once: true });
      }
    }

    /**
     * Process a single <canvas> element (handles PDF.js pages)
     */
    async processCanvas(canvas) {
      if (!this.enabled || this.inFlight.has(canvas)) return;
      if (canvas.width < MIN_CANVAS_W || canvas.height < MIN_CANVAS_H ||
          canvas.offsetWidth === 0) return;

      if (this.isTainted(canvas)) {
        console.warn('[ScreenShield] Skipped tainted cross-origin canvas:', canvas);
        this.processedElements.set(canvas, Date.now());
        return;
      }

      this.processedElements.set(canvas, Date.now());
      this.inFlight.add(canvas);
      try {
        await this.runOcrOnElement(canvas, canvas);
      } catch (err) {
        console.warn('[ScreenShield] Canvas OCR processing failed:', err);
      } finally {
        this.inFlight.delete(canvas);
      }
    }

    /**
     * Process an <img> tag
     */
    async processImage(img) {
      if (!this.enabled || this.inFlight.has(img)) return;
      if (!img.complete || img.naturalWidth < MIN_CANVAS_W ||
          img.naturalHeight < MIN_CANVAS_H) return;

      this.processedElements.set(img, Date.now());
      this.inFlight.add(img);
      try {
        const tmp = document.createElement('canvas');
        tmp.width = img.naturalWidth;
        tmp.height = img.naturalHeight;
        const ctx = tmp.getContext('2d');
        ctx.drawImage(img, 0, 0);

        if (this.isTainted(tmp)) {
          // Cross-origin image: pixels are unreadable in the page (tainted
          // canvas). The service worker holds <all_urls> host permission,
          // so it can fetch the bytes directly and OCR them offscreen.
          this.runOcrOnUrl(img.currentSrc || img.src, img);
          return;
        }
        await this.runOcrOnElement(tmp, img);
      } catch (err) {
        console.warn('[ScreenShield] Image OCR processing skipped:', err);
      } finally {
        this.inFlight.delete(img);
      }
    }

    /**
     * Send raster to the offscreen OCR worker and attach overlays
     */
    async runOcrOnElement(sourceCanvas, targetElement) {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        return;
      }

      let dataUrl;
      try {
        dataUrl = sourceCanvas.toDataURL('image/png');
      } catch (e) {
        return; // tainted
      }

      chrome.runtime.sendMessage({
        action: 'RUN_OCR_OFFSCREEN',
        imageDataUrl: dataUrl,
        langs: this.getOcrLangs()
      }, (res) => {
        if (chrome.runtime.lastError || !res || res.status !== 'OK' || !res.ocrData) {
          return;
        }
        this.handleOcrResult(res.ocrData, targetElement);
      });
    }

    /**
     * Cross-origin image path: the SW fetches the bytes (host permission)
     * and forwards them to the offscreen OCR worker. Handles the majority
     * of real-world images (CDN-hosted) that taint the canvas.
     */
    runOcrOnUrl(url, targetElement) {
      if (!url || !/^https?:/i.test(url)) return;
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        return;
      }
      try {
        chrome.runtime.sendMessage({
          action: 'RUN_OCR_ON_URL',
          url,
          langs: this.getOcrLangs()
        }, (res) => {
          if (chrome.runtime.lastError || !res || res.status !== 'OK' || !res.ocrData) {
            return;
          }
          this.handleOcrResult(res.ocrData, targetElement);
        });
      } catch (e) {}
    }

    /**
     * OCR language set for this page: 'eng+hin' when the document is an
     * Indic-language page (lang attribute) or contains Devanagari text;
     * 'eng' otherwise. Computed once and cached per page.
     */
    getOcrLangs() {
      if (this._ocrLangs) return this._ocrLangs;
      let langs = 'eng';
      try {
        const docLang = (document.documentElement.lang || '').toLowerCase();
        const indic = /^(hi|mr|ne|sa|bho|mai|doi|kok)/.test(docLang);
        if (!indic) {
          const sample = (document.body && document.body.innerText || '').slice(0, 20000);
          if (/[\u0900-\u097F]/.test(sample)) langs = 'eng+hin';
        } else {
          langs = 'eng+hin';
        }
      } catch (e) {}
      this._ocrLangs = langs;
      return langs;
    }

    /**
     * Parses OCR words & lines, runs regex detection, and adds overlays
     */
    handleOcrResult(ocrData, targetElement) {
      if (!this.enabled || !ocrData || !targetElement) return;

      // Drop previously-added OCR overlays for this element - a re-scan
      // after repaint/staleness must replace, not stack, results.
      // Scoped to OCR_BOX so an element-level overlay on the same node
      // (e.g. a user's "blur this element" selector rule) survives.
      this.overlayManager.removeOverlaysForElement(targetElement, 'OCR_BOX');

      // Source raster dimensions - boxes are stored in source-pixel space
      // and rescaled live by the overlay manager, so they stay glued when
      // the element resizes (PDF zoom, responsive dashboards).
      const srcW = targetElement.naturalWidth || targetElement.width || 1;
      const srcH = targetElement.naturalHeight || targetElement.height || 1;

      // 1. Check individual words
      for (const word of (ocrData.words || [])) {
        const text = word.text ? word.text.trim() : '';
        if (!text || text.length < 3 || !word.bbox) continue;

        const matches = this.regexEngine.findMatches(text);
        for (const m of matches) {
          const box = {
            x0: word.bbox.x0, y0: word.bbox.y0,
            x1: word.bbox.x1, y1: word.bbox.y1,
            srcW, srcH
          };
          const id = this.overlayManager.addOcrOverlay(targetElement, box, {
            category: m.category,
            ruleId: 'ocr_' + m.ruleId,
            badge: `📷 ${m.badge}`,
            color: m.color || '#14b8a6',
            value: m.value
          });
          if (id) {
            this.onDetection({
              category: m.category,
              ruleId: 'ocr_' + m.ruleId,
              badge: `OCR ${m.badge}`,
              url: window.location.href,
              timestamp: Date.now()
            });
          }
        }
      }

      // 2. Whole lines (secrets split across spaces)
      for (const line of (ocrData.lines || [])) {
        const lineText = line.text ? line.text.trim() : '';
        if (!lineText) continue;
        const lineMatches = this.regexEngine.findMatches(lineText);

        for (const lm of lineMatches) {
          const matchingWords = (line.words || []).filter(w =>
            w.text && lm.value.includes(w.text.trim())
          );
          if (matchingWords.length === 0) continue;

          const x0 = Math.min(...matchingWords.map(w => w.bbox.x0));
          const y0 = Math.min(...matchingWords.map(w => w.bbox.y0));
          const x1 = Math.max(...matchingWords.map(w => w.bbox.x1));
          const y1 = Math.max(...matchingWords.map(w => w.bbox.y1));

          this.overlayManager.addOcrOverlay(targetElement, { x0, y0, x1, y1, srcW, srcH }, {
            category: lm.category,
            ruleId: 'ocr_' + lm.ruleId,
            badge: `📷 ${lm.badge}`,
            color: lm.color || '#14b8a6',
            value: lm.value
          });
        }
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { OcrDetector };
  } else {
    global.ScreenShieldOcrDetector = OcrDetector;
  }
})(typeof window !== 'undefined' ? window : globalThis);
