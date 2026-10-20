/**
 * ScreenShield Protected PDF Viewer
 * Renders PDFs with bundled pdf.js (100% offline), lays a transparent text
 * layer over each canvas, and runs the ScreenShield detection modules
 * directly in-page (extension pages can't host content scripts, so the
 * modules are loaded as regular scripts).
 *
 * Text PDFs  -> text layer -> DOM scanning (instant, precise).
 * Scanned PDFs -> canvas OCR via offscreen detector when enabled.
 */

(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const fileUrl = params.get('file');
  const container = document.getElementById('viewerContainer');

  let scale = 1.2;
  let pdfDoc = null;
  let scanner = null;
  let overlayMgr = null;

  function showError(title, detail) {
    container.innerHTML = `
      <div class="error-box">
        <h2>⚠️ ${escapeHtml(title)}</h2>
        <p>${escapeHtml(detail)}</p>
        <p style="margin-top:14px">
          <a href="${escapeHtml(fileUrl || '#')}" target="_blank" rel="noopener">Open original PDF directly</a>
          &nbsp;·&nbsp; To protect <code>file://</code> PDFs, enable
          <em>"Allow access to file URLs"</em> for this extension at
          <code>chrome://extensions</code>.
        </p>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // -------------------------------------------------------------------
  // ScreenShield module bootstrap (manual - this is an extension page)
  // -------------------------------------------------------------------

  async function loadConfig() {
    try {
      const res = await chrome.storage.local.get(['sps_config']);
      if (res.sps_config) return res.sps_config;
    } catch (e) {}
    try {
      const r = await fetch(chrome.runtime.getURL('config/default_rules.json'));
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  async function initShield(cfg) {
    cfg = cfg || {};
    const categories = cfg.categories || {};
    const settings = cfg.settings || {};

    const engine = new window.ScreenShieldRegexEngine();
    engine.configure(categories, cfg.customRegexRules || []);

    const hover = new window.ScreenShieldHoverController({
      revealDelayMs: settings.revealDelayMs || 250,
      requireAltKey: !!settings.requireAltKey
    });

    overlayMgr = new window.ScreenShieldOverlayManager({
      hoverController: hover,
      blurIntensity: settings.blurIntensity || 8,
      maxOverlays: settings.maxOverlays || 300
    });
    hover.overlayManager = overlayMgr;

    try {
      const css = await fetch(chrome.runtime.getURL('src/content/overlay_styles.css'));
      overlayMgr.injectStyles(await css.text());
    } catch (e) {}

    // OCR detector - covers scanned PDFs whose pages have no text layer.
    // Inference runs in the offscreen document; this page just sends pixels.
    let ocrDetector = null;
    if (window.ScreenShieldOcrDetector) {
      ocrDetector = new window.ScreenShieldOcrDetector({
        regexEngine: engine,
        overlayManager: overlayMgr,
        enabled: !!settings.enableOcr,
        onDetection: () => {}
      });
    }

    scanner = new window.ScreenShieldDomScanner({
      regexEngine: engine,
      overlayManager: overlayMgr,
      ocrDetector: ocrDetector,
      selectorRules: cfg.selectorRules || [],
      allowlistedHashes: new Set(settings.allowlistedValueHashes || []),
      onDetection: () => {}
    });
    window.__spsOcrDetector = ocrDetector;

    // Present mode state passthrough
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'PRESENT_MODE_CHANGED') {
          overlayMgr.setPresentMode(!!msg.active, {
            watermarkText: (settings.presentMode || {}).watermarkText,
            watermarkEnabled: (settings.presentMode || {}).watermarkEnabled !== false
          });
        }
      });
      chrome.runtime.sendMessage({ action: 'GET_PRESENT_MODE' }, (res) => {
        if (!chrome.runtime.lastError && res && res.active) {
          overlayMgr.setPresentMode(true, {});
        }
      });
    } catch (e) {}
  }

  // -------------------------------------------------------------------
  // pdf.js rendering
  // -------------------------------------------------------------------

  async function renderPdf() {
    if (!window.pdfjsLib) {
      showError('PDF engine missing', 'Run `npm run build` to produce src/lib/pdfjs.bundle.js.');
      return;
    }
    if (!fileUrl) {
      showError('No document specified', 'Missing ?file= parameter.');
      return;
    }

    document.getElementById('openOriginal').href = fileUrl;
    try {
      document.getElementById('docName').textContent =
        decodeURIComponent(new URL(fileUrl).pathname.split('/').pop() || 'document.pdf');
    } catch (e) {
      document.getElementById('docName').textContent = 'document.pdf';
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc =
      chrome.runtime.getURL('src/lib/pdf.worker.min.mjs');

    let doc;
    try {
      doc = await pdfjsLib.getDocument({
        url: fileUrl,
        isEvalSupported: false,
        cMapUrl: chrome.runtime.getURL('src/lib/cmaps/'),
        cMapPacked: true
      }).promise;
    } catch (err) {
      showError('Could not load PDF', String(err && err.message || err));
      return;
    }
    pdfDoc = doc;
    document.getElementById('pageInfo').textContent =
      `${doc.numPages} page${doc.numPages > 1 ? 's' : ''}`;

    await renderAllPages();
  }

  // Rapid zoom clicks used to interleave two render loops and append
  // duplicate pages. A generation token makes stale loops bail out.
  let renderGen = 0;

  async function renderAllPages() {
    const gen = ++renderGen;
    const loading = document.getElementById('loading');
    if (loading) loading.remove();
    container.innerHTML = '';

    for (let p = 1; p <= pdfDoc.numPages; p++) {
      if (gen !== renderGen) return; // superseded by a newer render
      const page = await pdfDoc.getPage(p);
      const viewport = page.getViewport({ scale });

      const pageEl = document.createElement('div');
      pageEl.className = 'pdf-page';
      pageEl.style.width = viewport.width + 'px';
      pageEl.style.height = viewport.height + 'px';

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');

      const textLayer = document.createElement('div');
      textLayer.className = 'textLayer';
      textLayer.style.width = viewport.width + 'px';
      textLayer.style.height = viewport.height + 'px';

      pageEl.appendChild(canvas);
      pageEl.appendChild(textLayer);
      container.appendChild(pageEl);

      await page.render({ canvasContext: ctx, viewport }).promise;
      await renderTextLayer(page, viewport, textLayer);
    }

    if (gen !== renderGen) return; // a newer render tore this DOM down
    if (scanner) scanner.scan();
    if (window.__spsOcrDetector && window.__spsOcrDetector.enabled) {
      window.__spsOcrDetector.scanMediaElements(container);
    }
    if (overlayMgr) overlayMgr.requestSync();
  }

  /**
   * Transparent text spans positioned to match the canvas render.
   * DOM text nodes here are scanned/redacted like any webpage text.
   */
  async function renderTextLayer(page, viewport, layerEl) {
    const textContent = await page.getTextContent();
    const Util = pdfjsLib.Util;

    for (const item of textContent.items) {
      const str = item.str;
      if (!str || !str.trim()) continue;

      const tx = Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);

      const span = document.createElement('span');
      span.textContent = str;
      span.style.left = tx[4] + 'px';
      span.style.top = (tx[5] - fontHeight) + 'px';
      span.style.fontSize = fontHeight + 'px';
      span.style.fontFamily = 'sans-serif';
      if (item.width > 0 && fontHeight > 0) {
        // Stretch glyphs to match rendered width
        const scaleX = (item.width * scale) / (span.textContent.length || 1);
        span.style.letterSpacing = '0px';
      }
      layerEl.appendChild(span);
    }
  }

  // -------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------

  function initToolbar() {
    const zoomLabel = document.getElementById('zoomLevel');
    const setZoom = (v) => {
      scale = Math.min(3, Math.max(0.4, v));
      zoomLabel.textContent = Math.round(scale * 100) + '%';
      if (pdfDoc) {
        if (overlayMgr) overlayMgr.clearAll();
        renderAllPages();
      }
    };
    document.getElementById('zoomIn').addEventListener('click', () => setZoom(scale + 0.2));
    document.getElementById('zoomOut').addEventListener('click', () => setZoom(scale - 0.2));
  }

  // -------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', async () => {
    initToolbar();
    const cfg = await loadConfig();
    await initShield(cfg);
    await renderPdf();
  });
})();
