#!/usr/bin/env node
/**
 * E2E: load the unpacked extension in real Chrome and verify redaction.
 *
 *   npm run test:e2e                  # headless
 *   SPS_E2E_HEADED=1 npm run test:e2e # watch it run
 *
 * Uses playwright-core + the system Chrome - no browser download required.
 * Chrome >= 137 ignores --load-extension on branded builds, so the extension
 * is installed via CDP Extensions.loadUnpacked instead.
 * The repo is served over http://127.0.0.1 because content scripts cannot
 * run on file:// URLs without explicit user opt-in.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADED = !!process.env.SPS_E2E_HEADED;
const TIMEOUT = 45_000;
const CHROME = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.txt': 'text/plain',
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.join(ROOT, rel || 'test/test_page.html');
      if (!file.startsWith(ROOT) || !existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function waitForDevtoolsPort(profile) {
  const f = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 60; i++) {
    if (existsSync(f)) return `http://127.0.0.1:${readFileSync(f, 'utf8').split('\n')[0]}`;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Chrome DevTools port never appeared');
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
};

async function main() {
  if (!existsSync(path.join(ROOT, 'src/lib/transformers.bundle.js'))) {
    console.warn('[e2e] src/lib bundles missing - run `npm run build` first');
  }
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);

  const server = await serve();
  const port = server.address().port;
  const profile = mkdtempSync(path.join(tmpdir(), 'sps-e2e-'));
  const chromeArgs = [
    '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    ...(HEADED ? [] : ['--headless=new', '--window-size=1400,900']),
    'about:blank',
  ];
  const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore' });
  let browser;

  try {
    const wsEndpoint = await waitForDevtoolsPort(profile);
    browser = await chromium.connectOverCDP(wsEndpoint);
    const browserSession = await browser.newBrowserCDPSession();
    const { id: extensionId } = await browserSession.send('Extensions.loadUnpacked', { path: ROOT });
    check('extension loaded via CDP', /^[a-p]{32}$/.test(extensionId), extensionId);

    const context = browser.contexts()[0];
    const sw = await context.waitForEvent('serviceworker', { timeout: TIMEOUT })
      .catch(() => context.serviceWorkers().find((w) => w.url().includes(extensionId)));
    check('service worker started', !!sw && sw.url().includes('service_worker.js'));

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(`http://127.0.0.1:${port}/test/test_page.html`, { waitUntil: 'load' });

    // Overlays live in an open shadow root; the container is briefly
    // double-mounted during init, so query across all of them.
    const overlayCount = () =>
      [...document.querySelectorAll('#screen-privacy-shield-container')]
        .reduce((n, c) => n + (c.shadowRoot?.querySelectorAll('.sps-blur-overlay').length || 0), 0);

    await page.waitForFunction(
      () => document.querySelector('#screen-privacy-shield-container'),
      { timeout: TIMEOUT }
    );
    check('overlay container mounted', true);

    await page.waitForFunction(
      () => [...document.querySelectorAll('#screen-privacy-shield-container')]
        .reduce((n, c) => n + (c.shadowRoot?.querySelectorAll('.sps-blur-overlay').length || 0), 0) >= 10,
      { timeout: TIMEOUT }
    );
    const count = await page.evaluate(overlayCount);
    check('blur overlays rendered on PII test page', count >= 10, `${count} overlays`);

    // Regression guard: overlays must actually sit over content, not be
    // clamped at 0,0 (DOMRect spread once produced NaN positions).
    const positioned = await page.evaluate(() =>
      [...document.querySelectorAll('#screen-privacy-shield-container')].flatMap((c) =>
        [...(c.shadowRoot?.querySelectorAll('.sps-blur-overlay') || [])])
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.top > 20 && r.width > 10;
        }).length);
    check('overlays positioned over content (not 0,0)', positioned >= 5, `${positioned} positioned`);

    const badges = await page.evaluate(() =>
      [...document.querySelectorAll('#screen-privacy-shield-container')].flatMap((c) =>
        [...(c.shadowRoot?.querySelectorAll('.sps-badge-text') || [])].map((b) => b.textContent)));
    check('category badges present', badges.length > 0, [...new Set(badges)].slice(0, 8).join(', '));

    const fatal = errors.filter((e) => !/favicon|net::ERR/i.test(e));
    check('no content-script errors', fatal.length === 0, fatal[0] || '');

    for (const [name, rel] of [['popup', 'src/popup/popup.html'], ['options', 'src/options/options.html']]) {
      const p2 = await context.newPage();
      const errs = [];
      p2.on('pageerror', (e) => errs.push(String(e)));
      await p2.goto(`chrome-extension://${extensionId}/${rel}`);
      await p2.waitForTimeout(800);
      check(`${name} page loads`, errs.length === 0, errs[0] || '');
      await p2.close();
    }
  } finally {
    await browser?.close().catch(() => {});
    chrome.kill('SIGKILL');
    server.close();
    for (let i = 0; i < 10; i++) {
      try { rmSync(profile, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} e2e checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('[e2e] FAILED:', e); process.exit(1); });
