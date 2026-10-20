/**
 * Screen Privacy Shield - Offscreen Worker Host
 * Runs OCR (Tesseract.js) and NER (Transformers.js) fully offline inside an
 * isolated offscreen document, safe from host-page CSP.
 *
 * All model files are vendored inside the extension (models/), so no network
 * access happens at runtime.
 *
 * Message contract (routed via the service worker):
 *   { target: 'offscreen', action: 'RUN_OCR_OFFSCREEN', imageDataUrl }
 *     -> { status: 'OK', ocrData: { words: [{text,bbox}], lines: [{text,bbox,words}] } }
 *   { target: 'offscreen', action: 'RUN_NER_OFFSCREEN', text, nodeHash }
 *     -> { status: 'OK', entities: [{type,start,end,word}] }
 *   { target: 'offscreen', action: 'RUN_NER_OFFSCREEN', texts: [{nodeHash, text}] }
 *     -> { status: 'OK', entitiesByHash: { [nodeHash]: [...] } }
 */

(function () {
  'use strict';

  const NER_MODEL_ID = 'onnx-community/distilbert-NER-ONNX';

  let tesseractWorker = null;
  let nerPipeline = null;
  let nerInitPromise = null;
  let busyCount = 0;

  function taskDone() {
    busyCount = Math.max(0, busyCount - 1);
    if (busyCount === 0) {
      try {
        chrome.runtime.sendMessage({ action: 'OFFSCREEN_TASK_DONE' }, () => {
          if (chrome.runtime.lastError) {}
        });
      } catch (e) {}
    }
  }

  // ---------------------------------------------------------------
  // Tesseract OCR (bundled worker + core + traineddata - offline)
  // ---------------------------------------------------------------

  let tesseractLangs = 'eng';
  // Serialized build chain: an 'eng+hin' request during an in-flight 'eng'
  // build must NOT reuse that promise (it would return an English-only
  // worker). Chaining makes each language build run after the previous,
  // re-checking tesseractLangs before doing real work.
  let tesseractInitChain = Promise.resolve();

  function initTesseract(langs = 'eng') {
    const job = tesseractInitChain.then(async () => {
      if (tesseractWorker && tesseractLangs === langs) return tesseractWorker;
      if (typeof Tesseract === 'undefined') {
        throw new Error('Tesseract bundle not loaded');
      }
      // Language set changed (e.g. eng -> eng+hin on a Devanagari page):
      // recreate the worker once - worst case is one rebuild per page.
      if (tesseractWorker && tesseractLangs !== langs) {
        try { await tesseractWorker.terminate(); } catch (e) {}
        tesseractWorker = null;
      }
      const base = chrome.runtime.getURL('');
      tesseractWorker = await Tesseract.createWorker(langs.split('+'), undefined, {
        workerPath: base + 'src/lib/worker.min.js',
        corePath: base + 'src/lib/tesseract-core/',
        langPath: base + 'models/ocr/',
        gzip: true,
        cacheMethod: 'none',
        logger: () => {}
      });
      tesseractLangs = langs;
      return tesseractWorker;
    });
    tesseractInitChain = job.catch(() => {});
    return job;
  }

  async function runOcr(imageDataUrl, langs) {
    const worker = await initTesseract(langs || 'eng');
    const res = await worker.recognize(imageDataUrl, {}, {
      blocks: true, hocr: false, tsv: false, text: true
    });
    const d = res && res.data ? res.data : {};

    const words = [];
    const lines = [];

    if (Array.isArray(d.words)) {
      for (const w of d.words) {
        words.push({ text: w.text || '', bbox: w.bbox });
      }
    } else if (Array.isArray(d.blocks)) {
      for (const b of d.blocks) {
        for (const p of b.paragraphs || []) {
          for (const l of p.lines || []) {
            lines.push({
              text: l.text || '', bbox: l.bbox,
              words: (l.words || []).map(w => ({ text: w.text || '', bbox: w.bbox }))
            });
            for (const w of l.words || []) {
              words.push({ text: w.text || '', bbox: w.bbox });
            }
          }
        }
      }
    }
    // If lines weren't nested in blocks but exist at top-level
    if (lines.length === 0 && Array.isArray(d.lines)) {
      for (const l of d.lines) {
        lines.push({
          text: l.text || '', bbox: l.bbox,
          words: (l.words || []).map(w => ({ text: w.text || '', bbox: w.bbox }))
        });
      }
    }

    return { words, lines, text: d.text || '' };
  }

  // ---------------------------------------------------------------
  // NER (Transformers.js token-classification - offline ONNX)
  // ---------------------------------------------------------------

  async function initNer() {
    if (nerPipeline) return nerPipeline;
    if (nerInitPromise) return nerInitPromise;

    nerInitPromise = (async () => {
      const T = window.SpsTransformers;
      if (!T) throw new Error('Transformers bundle not loaded');

      // Hard offline mode: vendored weights only
      T.env.allowRemoteModels = false;
      T.env.allowLocalModels = true;
      T.env.localModelPath = chrome.runtime.getURL('models/ner/');
      T.env.useBrowserCache = true;
      if (T.env.backends && T.env.backends.onnx && T.env.backends.onnx.wasm) {
        T.env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('src/lib/ort/');
        T.env.backends.onnx.wasm.numThreads = 1;
        T.env.backends.onnx.wasm.proxy = false;
      }

      nerPipeline = await T.pipeline('token-classification', NER_MODEL_ID, {
        dtype: 'q8'
      });
      return nerPipeline;
    })();

    try {
      return await nerInitPromise;
    } finally {
      nerInitPromise = null;
    }
  }

  function groupEntities(rawTokens, fullText) {
    const entities = [];
    let current = null;

    for (const token of rawTokens || []) {
      const tag = token.entity || token.entity_group || '';
      if (!tag || tag === 'O') {
        if (current) { entities.push(current); current = null; }
        continue;
      }
      const type = String(tag).replace(/^[BI]-/, '');
      const start = token.start !== undefined
        ? token.start : fullText.indexOf(token.word);
      const end = token.end !== undefined
        ? token.end : start + (token.word ? token.word.length : 0);
      if (start < 0 || start === undefined) continue;

      if (current && current.type === type && start <= current.end + 2) {
        current.end = end;
        current.word = fullText.substring(current.start, current.end);
      } else {
        if (current) entities.push(current);
        current = { type, start, end, word: fullText.substring(start, end) };
      }
    }
    if (current) entities.push(current);
    return entities;
  }

  async function runNer(text) {
    const pipe = await initNer();
    const out = await pipe(text);
    return groupEntities(out, text);
  }

  // ---------------------------------------------------------------
  // Message hub
  // ---------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return false;

    if (msg.action === 'RUN_OCR_OFFSCREEN') {
      busyCount++;
      (async () => {
        try {
          const ocrData = await runOcr(msg.imageDataUrl, msg.langs);
          sendResponse({ status: 'OK', ocrData });
        } catch (err) {
          sendResponse({ status: 'ERROR', error: String(err), ocrData: null });
        } finally {
          taskDone();
        }
      })();
      return true; // async
    }

    if (msg.action === 'RUN_NER_OFFSCREEN') {
      busyCount++;
      (async () => {
        try {
          if (Array.isArray(msg.texts)) {
            const entitiesByHash = {};
            for (const item of msg.texts) {
              entitiesByHash[item.nodeHash] = await runNer(item.text);
            }
            sendResponse({ status: 'OK', entitiesByHash });
          } else {
            const entities = await runNer(msg.text || '');
            sendResponse({ status: 'OK', entities });
          }
        } catch (err) {
          sendResponse({ status: 'ERROR', error: String(err), entities: [] });
        } finally {
          taskDone();
        }
      })();
      return true; // async
    }

    if (msg.action === 'PING_OFFSCREEN') {
      sendResponse({ status: 'OK', ready: true });
      return false;
    }

    sendResponse({ status: 'UNHANDLED', action: msg.action });
    return false;
  });
})();
