/**
 * End-to-end smoke test for the content pipeline under jsdom.
 * Exercises: module load order, orchestrator init, initial scan,
 * mutation-driven incremental rescan, form fields, removal cleanup.
 * Layout APIs that jsdom lacks are stubbed minimally.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function makeEnv(html) {
  const dom = new JSDOM(html || '<body></body>', {
    url: 'https://example.com/page',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;

  // jsdom lacks layout: give every element a rect + visibility.
  window.Element.prototype.getBoundingClientRect = function () {
    return { top: 10, left: 10, right: 210, bottom: 30, width: 200, height: 20, x: 10, y: 10 };
  };
  window.Element.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()];
  };
  window.Range.prototype.getClientRects = function () {
    return [{ top: 10, left: 10, right: 210, bottom: 30, width: 200, height: 20, x: 10, y: 10 }];
  };
  window.Range.prototype.getBoundingClientRect = function () {
    return { top: 10, left: 10, right: 210, bottom: 30, width: 200, height: 20, x: 10, y: 10 };
  };
  if (!window.Element.prototype.checkVisibility) {
    window.Element.prototype.checkVisibility = function () { return true; };
  }
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get() { return 100; } });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { get() { return 20; } });

  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.scrollX = 0; window.scrollY = 0;
  window.chrome = undefined; // standalone preview path

  return window;
}

function loadModules(window) {
  const files = [
    'src/content/regex_engine.js',
    'src/content/hover_controller.js',
    'src/content/overlay_manager.js',
    'src/content/dom_scanner.js',
    'src/content/ner_detector.js',
    'src/content/ocr_detector.js',
    'src/content/content_main.js'
  ];
  for (const f of files) {
    window.eval(read(f));
  }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** Tear down modules so timers/observers don't keep the event loop alive. */
function teardown(window) {
  try {
    if (window.__spsDomScanner && window.__spsDomScanner.destroy) {
      window.__spsDomScanner.destroy();
    }
    if (window.__spsOverlayManager && window.__spsOverlayManager.destroy) {
      window.__spsOverlayManager.destroy();
    }
  } catch (e) {}
  try { window.close(); } catch (e) {}
}

test('orchestrator init: modules construct and initial scan runs', async () => {
  const window = makeEnv(`<body><p>Card: 4012 8888 8888 1881 and email a@b.co</p></body>`);
  loadModules(window);
  await wait(80);

  assert.ok(window.__spsOverlayManager, 'overlay manager should initialize');
  assert.ok(window.__spsDomScanner, 'dom scanner should initialize');
  const doc = window.document;
  assert.ok(doc.getElementById('screen-privacy-shield-container'), 'overlay container mounted');
  assert.ok(window.__spsOverlayManager.getActiveCount() >= 2,
    'expected >=2 overlays, got ' + window.__spsOverlayManager.getActiveCount());
  teardown(window);
});

test('real-time: dynamically added node gets an overlay', async () => {
  const window = makeEnv(`<body><p>hello</p></body>`);
  loadModules(window);
  await wait(80);
  const mgr = window.__spsOverlayManager;
  const before = mgr.getActiveCount();

  const p = window.document.createElement('p');
  p.textContent = 'SSN 123-45-6789 injected live';
  window.document.body.appendChild(p);
  await wait(300); // debounce + scan

  assert.ok(mgr.getActiveCount() > before,
    `expected overlay count > ${before}, got ${mgr.getActiveCount()}`);
  teardown(window);
});

test('real-time: textContent replacement re-scans', async () => {
  const window = makeEnv(`<body><p id="t">nothing here</p></body>`);
  loadModules(window);
  await wait(80);
  const mgr = window.__spsOverlayManager;
  const before = mgr.getActiveCount();

  window.document.getElementById('t').textContent = 'now has sarah@corp.io inside';
  await wait(300);

  assert.ok(mgr.getActiveCount() > before, 'mutation did not trigger rescan');
  teardown(window);
});

test('form field values are covered', async () => {
  const window = makeEnv(
    `<body><input id="f" value="${'sk' + '_live_' + '51Mzxyz1234567890abcdef123456'}"></body>`);
  loadModules(window);
  await wait(120);
  assert.ok(window.__spsOverlayManager.getActiveCount() >= 1,
    'input value was not redacted');
  teardown(window);
});

test('removing a node removes its overlay', async () => {
  const window = makeEnv(`<body><p id="victim">SSN 123-45-6789</p></body>`);
  loadModules(window);
  await wait(100);
  const mgr = window.__spsOverlayManager;
  assert.ok(mgr.getActiveCount() >= 1);

  window.document.getElementById('victim').remove();
  await wait(300);
  assert.strictEqual(mgr.getActiveCount(), 0, 'stale overlay survived node removal');
  teardown(window);
});
