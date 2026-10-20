#!/usr/bin/env node
/**
 * Screen Privacy Shield - Build Script
 * Bundles offline ML libraries into src/lib/ and vendors model weights into models/.
 * After this build, the extension runs 100% offline - zero runtime network access.
 *
 * Usage:
 *   node build.mjs              # bundle libs + vendor models
 *   node build.mjs --libs-only  # bundle libs only
 *   node build.mjs --models-only# vendor models only
 */

import * as esbuild from 'esbuild';
import { createGzip } from 'zlib';
import {
  mkdirSync, existsSync, copyFileSync, writeFileSync,
  createWriteStream, createReadStream, readFileSync, readdirSync, statSync
} from 'fs';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.join(ROOT, 'src', 'lib');
const MODELS_DIR = path.join(ROOT, 'models');
const ENTRY_DIR = path.join(ROOT, 'build_entries');

const LIBS_ONLY = process.argv.includes('--libs-only');
const MODELS_ONLY = process.argv.includes('--models-only');
const UPDATE_CHECKSUMS = process.argv.includes('--update-checksums');
const SKIP_VERIFY = process.argv.includes('--no-verify');

const log = (...a) => console.log('[build]', ...a);
const ensureDir = (d) => mkdirSync(d, { recursive: true });

function cp(src, destDir) {
  ensureDir(destDir);
  const dest = path.join(destDir, path.basename(src));
  copyFileSync(src, dest);
  log(`copied ${path.relative(ROOT, src)} -> ${path.relative(ROOT, dest)}`);
}

async function download(url, dest) {
  ensureDir(path.dirname(dest));
  if (existsSync(dest) && statSync(dest).size > 0) {
    log(`exists, skipping: ${path.relative(ROOT, dest)}`);
    return;
  }
  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  log(`  -> ${path.relative(ROOT, dest)} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
}

// ---------------------------------------------------------------------------
// SHA-256 integrity (supply-chain: vendored models verified on every build)
// ---------------------------------------------------------------------------

const CHECKSUM_FILE = path.join(ROOT, 'models.sha256.json');
const observedHashes = new Map(); // rel path -> sha256

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Hash a vendored artifact and record it for lockfile compare/write. */
async function trackIntegrity(relPath) {
  const abs = path.join(MODELS_DIR, relPath);
  if (!existsSync(abs)) {
    throw new Error(`Integrity: expected artifact missing: ${relPath}`);
  }
  observedHashes.set(relPath, await sha256File(abs));
}

function verifyChecksums() {
  if (SKIP_VERIFY) { log('integrity: verification skipped (--no-verify)'); return; }
  if (UPDATE_CHECKSUMS || !existsSync(CHECKSUM_FILE)) {
    const out = {};
    for (const [k, v] of [...observedHashes.entries()].sort()) out[k] = v;
    writeFileSync(CHECKSUM_FILE, JSON.stringify({ sha256: out }, null, 2) + '\n');
    log(`integrity: ${UPDATE_CHECKSUMS ? 'updated' : 'wrote'} ${path.relative(ROOT, CHECKSUM_FILE)} (${Object.keys(out).length} files)`);
    return;
  }
  const expected = JSON.parse(readFileSync(CHECKSUM_FILE, 'utf8')).sha256 || {};
  const mismatches = [];
  for (const [rel, actual] of observedHashes) {
    if (!(rel in expected)) { mismatches.push(`${rel}: no pinned hash`); continue; }
    if (expected[rel] !== actual) mismatches.push(`${rel}: expected ${expected[rel]}, got ${actual}`);
  }
  if (mismatches.length) {
    throw new Error(
      `Model integrity check FAILED (${mismatches.length}):\n  ` +
      mismatches.join('\n  ') +
      `\n  If the upstream model was intentionally re-vendored, run: node build.mjs --models-only --update-checksums`
    );
  }
  log(`integrity: ${observedHashes.size} model artifacts verified (sha256)`);
}

// ---------------------------------------------------------------------------
// Library bundling
// ---------------------------------------------------------------------------

async function bundleLibs() {
  ensureDir(LIB_DIR);
  ensureDir(ENTRY_DIR);

  // --- Tesseract.js: ship the official prebuilt dist (worker + core) ---
  const tessDist = path.join(ROOT, 'node_modules', 'tesseract.js', 'dist');
  cp(path.join(tessDist, 'tesseract.min.js'), LIB_DIR);
  cp(path.join(tessDist, 'worker.min.js'), LIB_DIR);

  // tesseract.js-core WASM runtimes (LSTM + SIMD variants)
  const coreSrc = path.join(ROOT, 'node_modules', 'tesseract.js-core');
  const coreDest = path.join(LIB_DIR, 'tesseract-core');
  for (const f of readdirSync(coreSrc)) {
    if (/^tesseract-core.*\.(wasm|js)$/.test(f) && f !== 'index.js') {
      cp(path.join(coreSrc, f), coreDest);
    }
  }

  // --- ONNX Runtime WASM binaries for transformers.js ---
  const ortDist = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
  const ortDest = path.join(LIB_DIR, 'ort');
  for (const f of readdirSync(ortDist)) {
    if (/^ort-wasm.*\.wasm$/.test(f)) cp(path.join(ortDist, f), ortDest);
  }

  // --- Transformers.js -> IIFE bundle exposing window.SpsTransformers ---
  writeFileSync(path.join(ENTRY_DIR, 'transformers.entry.js'), `
import * as T from '@huggingface/transformers';
window.SpsTransformers = T;
`);

  // --- pdf.js -> IIFE bundle exposing window.pdfjsLib ---
  writeFileSync(path.join(ENTRY_DIR, 'pdfjs.entry.js'), `
import * as pdfjs from 'pdfjs-dist';
window.pdfjsLib = pdfjs;
`);

  const shared = {
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    minify: true,
    logLevel: 'warning',
    // Node-only deps of transformers.js are not needed in the extension context
    alias: {
      'sharp': path.join(ENTRY_DIR, 'stub.js'),
      'fs': path.join(ENTRY_DIR, 'stub.js'),
      'path': path.join(ENTRY_DIR, 'stub.js'),
      'url': path.join(ENTRY_DIR, 'stub.js'),
    },
  };
  writeFileSync(path.join(ENTRY_DIR, 'stub.js'), 'export default {}; export const readFileSync = undefined;\n');

  await esbuild.build({
    ...shared,
    entryPoints: [path.join(ENTRY_DIR, 'transformers.entry.js')],
    outfile: path.join(LIB_DIR, 'transformers.bundle.js'),
  });
  log('bundled transformers.bundle.js');

  await esbuild.build({
    ...shared,
    entryPoints: [path.join(ENTRY_DIR, 'pdfjs.entry.js')],
    outfile: path.join(LIB_DIR, 'pdfjs.bundle.js'),
  });
  log('bundled pdfjs.bundle.js');

  // pdf.js worker (loaded via GlobalWorkerOptions.workerSrc at runtime)
  cp(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'), LIB_DIR);

  // pdf.js CMaps (required for CJK/composite-font PDFs)
  const cmapSrc = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'cmaps');
  const cmapDest = path.join(LIB_DIR, 'cmaps');
  if (existsSync(cmapSrc)) {
    for (const f of readdirSync(cmapSrc)) {
      if (f.endsWith('.bcmap')) cp(path.join(cmapSrc, f), cmapDest);
    }
  }
}

// ---------------------------------------------------------------------------
// Model vendoring (build-time download -> fully offline runtime)
// ---------------------------------------------------------------------------

const NER_MODEL = 'onnx-community/distilbert-NER-ONNX';
const HF = 'https://huggingface.co';

async function vendorModels() {
  // --- NER model (distilbert NER, quantized ONNX ~66MB) ---
  const nerDir = path.join(MODELS_DIR, 'ner', NER_MODEL);
  const nerFiles = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'vocab.txt',
    'onnx/model_quantized.onnx',
  ];
  for (const f of nerFiles) {
    await download(`${HF}/${NER_MODEL}/resolve/main/${f}`, path.join(nerDir, f));
    await trackIntegrity(`ner/${NER_MODEL}/${f}`);
  }

  // --- Tesseract traineddata (tessdata_fast, gzipped) ---
  // eng = default; hin = Devanagari (auto-enabled on Hindi/Marathi/etc pages)
  const ocrDir = path.join(MODELS_DIR, 'ocr');
  for (const lang of ['eng', 'hin']) {
    const rawTessdata = path.join(ocrDir, `${lang}.traineddata`);
    const gzTessdata = path.join(ocrDir, `${lang}.traineddata.gz`);
    if (!existsSync(gzTessdata)) {
      await download(`https://github.com/tesseract-ocr/tessdata_fast/raw/main/${lang}.traineddata`, rawTessdata);
      await pipeline(createReadStream(rawTessdata), createGzip(9), createWriteStream(gzTessdata));
      log(`gzipped -> ${path.relative(ROOT, gzTessdata)}`);
    }
    await trackIntegrity(`ocr/${lang}.traineddata.gz`);
  }
  verifyChecksums();
}

// ---------------------------------------------------------------------------

(async () => {
  try {
    if (!MODELS_ONLY) await bundleLibs();
    if (!LIBS_ONLY) await vendorModels();
    log('done.');
  } catch (err) {
    console.error('[build] FAILED:', err);
    process.exit(1);
  }
})();
