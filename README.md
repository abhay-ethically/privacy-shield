# Screen Privacy Shield v2 (Manifest V3 Extension)

**Screen Privacy Shield** is an enterprise-grade, client-side browser extension (Chrome, Edge, Brave, Chromium) for **data-leak prevention against shoulder-surfing, screen sharing, and phone-camera photography**.

It scans visible text, form fields, images, canvas, and PDFs in real time, and covers sensitive values with isolated Shadow DOM overlays — frosted-glass blur normally, **opaque redaction bars in Present Mode** while the tab is being shared. Everything runs **100% offline**: no remote API calls, no telemetry, model weights bundled inside the extension.

---

## What's new in v2.0

- **Present Mode (screen-sharing protection)**: auto-activates when the tab is captured (Meet/Zoom/Teams "share this tab" via `chrome.tabCapture`), or manually via `Alt+Shift+P` / popup. Opaque bars, hover-reveal lockout, red ribbon indicator, optional watermark.
- **Full frame coverage**: `all_frames` + `match_about_blank` — iframes, embedded widgets, and sandboxed frames are protected.
- **Shadow DOM traversal**: open shadow roots are scanned and observed.
- **Top-layer safety**: overlays remount inside fullscreen elements, modal `<dialog>`s, and popovers (they paint above `z-index` max).
- **Nested scroll lockstep**: capture-phase scroll listeners keep overlays glued to content inside `overflow` containers.
- **Form-field protection**: `input.value` / `textarea.value` / `title` / `alt` / `aria-label` / `placeholder` are scanned.
- **Expanded detection**: private key blocks, OpenAI/Anthropic/Slack/npm/PyPI tokens, connection strings & credentialed URLs, generic `key=secret` assignments, **India pack** (Aadhaar w/ Verhoeff, PAN, UPI, IFSC, GSTIN w/ NIC checksum, vehicle registration, driving licence, voter ID/EPIC, `+91` mobiles), passports, ABA routing, optional high-entropy strings.
- **Right-click privacy actions**: context menu → "Always blur this element", "Blur this selection", "Never blur this value" — persisted to your rules, no Options editing needed.
- **Meeting-site nudge**: visiting Meet, Zoom, Teams, Webex, Slack huddles etc. surfaces a one-click Present Mode suggestion — covers OS-level window sharing that no capture API can see.
- **Share notification**: a system notification fires the first time a tab starts being captured, so auto Present Mode is never silent.
- **GPU-friendly overlays**: overlays move via `transform` (compositor-only) instead of `top`/`left` layout writes — smooth at 60fps with hundreds of redactions. Leaf elements (inputs, images, canvases) are blurred via `filter:blur()` on the element itself — zero overlay-filter cost.
- **Pure-glass redaction**: chips are frosted glass — strong blur, near-zero tint, category-colored edge, and a compact label saying *what* is masked. Blur intensity is adjustable in Options and applies live.
- **Real offline NER + OCR**: bundled `@huggingface/transformers` (distilbert-NER, quantized ONNX) and `tesseract.js` run inside the offscreen document — zero network at runtime. OCR auto-selects **English + Hindi (Devanagari)** on Indic-language pages.
- **Protected PDF viewer**: `.pdf` navigations redirect to a bundled pdf.js viewer where the text layer gets redacted (scanned PDFs fall back to OCR).
- **Performance**: subtree-scoped incremental scans, viewport-first initial coverage, frame-budgeted DFS, batched layout I/O, covered-element pruning, overlay budget with overflow counter, multi-line rect precision.
- **Never-blur allowlist**: store value hashes that must never be redacted.
- **Compliance exports**: the audit tab can export CSV/JSON, plus a summarized Markdown compliance report (per-category and per-domain detection counts) — useful for DPDP-style reviews.

---

## Build (required before loading)

The extension ships its ML libraries and model weights inside the bundle — you must run the build once:

```bash
npm install
npm run build       # bundles libs -> src/lib/, vendors models -> models/ (~130MB)
```

`npm run build` bundles tesseract.js, transformers.js, and pdf.js into `src/lib/`, and downloads the NER ONNX weights + English/Hindi OCR traineddata into `models/`. After that, the extension is fully self-contained.

### Model integrity

Every vendored model artifact is SHA-256-hashed on each build and verified against `models.sha256.json` (committed). A tampered or corrupted download fails the build:

```bash
node build.mjs --models-only --update-checksums  # re-pin after intentional model upgrade
node build.mjs --no-verify                       # skip verification (not recommended)
```

## Install

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → select this folder.
2. To protect `file://` pages/PDFs: extension details → **Allow access to file URLs**.
3. Open `test/test_page.html` to see every detector in action (iframes, shadow DOM, dialogs, scroll panes, form fields, stress test).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+P` | Toggle **Present Mode** (opaque redaction for screen sharing) |
| `Alt+Shift+R` | Force full page re-scan |
| `Alt+Click` on a chip | Reveal that value (deliberate gesture; toggles back) |

Remap anytime at `chrome://extensions/shortcuts`.

## Detection coverage

| Type | Validation |
|---|---|
| Credit/debit cards | Luhn mod-10 |
| US SSN | SSA area/group/serial rules |
| IBAN | ISO 7064 mod-97-10 |
| Aadhaar (IN) | Verhoeff checksum |
| PAN (IN), UPI IDs, IFSC | format + handle/bank tables |
| GSTIN (IN) | NIC mod-36 checksum |
| Vehicle registration (IN), driving licence (IN) | state/RTO codes + issue-year sanity |
| Voter ID / EPIC (IN) | format |
| Indian mobile (`+91`/0-prefixed/10-digit) | starts 6–9 boundary rules |
| Passport (US/IN formats), ABA routing | format / 3-7-1 checksum |
| Emails, intl. phone | boundary rules |
| AWS, GitHub (all PAT types), Google, Stripe, OpenAI/Anthropic, Slack, npm/PyPI tokens | prefix + entropy gates |
| JWT | header decodes to JSON w/ `alg`/`typ` |
| Private key blocks (RSA/EC/OPENSSH/PGP/ENCRYPTED) | block structure |
| Connection strings & credentialed URLs | must embed `user:pass@` |
| `api_key=`/`password=`/`secret=` style assignments | entropy gate + placeholder filter |
| High-entropy strings | Shannon ≥4.5 (off by default) |
| CSS selectors & custom regex | admin rules (Options) |
| NER entities (PER/LOC/ORG) | on-device distilbert-NER ONNX (opt-in) |
| OCR text in images/canvas/PDF | on-device tesseract.js (opt-in) |

## Present Mode

- **Auto**: turns on when Chrome reports the tab is being captured (`tabCapture` API — covers Meet/Zoom/Teams tab sharing), and off when capture stops.
- **Manual**: `Alt+Shift+P` or the popup toggle. Required for OS-level window/screen capture, which no browser API can detect.
- While active: overlays become opaque `████` bars, hover reveal is disabled, a `● SCREENSHIELD — PRESENT MODE` ribbon renders inside the share feed, and an optional repeating watermark covers the viewport.
- Tunables in Options → Present Mode: auto-on-capture, opaque bars on/off, watermark text, and whether deliberate reveal stays allowed while sharing.
- Manually toggling Present Mode always wins over auto-detection — if you turn it off during a share it stays off for that session.

## Architecture

```
manifest.json                 MV3: all_frames, commands, tabCapture, webNavigation, offscreen
build.mjs                     esbuild bundler + model vendoring
config/default_rules.json     detection rules, categories, settings schema
models/                       vendored ONNX weights + eng.traineddata (git-ignored, built)
src/
  background/ service_worker.js   capture detection, commands, context menus, meeting nudge, notifications, PDF redirect, offscreen routing
  background/ audit_logger.js     SHA-256 field hashing, rolling 2k buffer, dedup, webhook
  content/    regex_engine.js     20+ validated detection rules
  content/    dom_scanner.js      budgeted DFS, shadow DOM, form fields, IO/RO/MutationObserver
  content/    overlay_manager.js  multi-rect overlays, top-layer remount, present mode, watermark
  content/    hover_controller.js reveal timing, Alt-key gate, present-mode lockout
  content/    ner_detector.js     batched NER queue -> offscreen
  content/    ocr_detector.js     canvas/image OCR -> offscreen, repaint re-scan
  offscreen/  offscreen.js        bundled Tesseract + Transformers inference host
  pdf_viewer/ pdf.html|js|css     bundled pdf.js viewer w/ text-layer redaction
  popup/      quick toggles + Present Mode + sharing indicator
  options/    admin dashboard, rules editor, allowlist, audit viewer
src/lib/                        esbuild bundles (git-ignored, built)
test/        regex_engine.test.js unit suite (node --test)
test/        e2e_extension.mjs    real-Chrome extension load + overlay assertion
models.sha256.json               pinned SHA-256 hashes for all vendored models
test/        test_page.html       interactive playground incl. v2 scenarios
test/        frame_inner.html     iframe coverage test
```

## Testing

```bash
npm test          # 45 tests: Luhn, IBAN, Verhoeff, ABA, GSTIN, JWT, all rules + jsdom pipeline smoke tests
npm run test:e2e  # real-Chrome test: loads the extension via CDP, asserts overlays on the PII test page
npm run serve     # serve dir for testing http:// pages
```

`test:e2e` uses `playwright-core` + your installed Chrome (no browser download). Set `CHROME_PATH` to override the binary location, `SPS_E2E_HEADED=1` to watch it run. Note: Chrome ≥137 ignores `--load-extension` on branded builds, so the harness installs the extension via CDP `Extensions.loadUnpacked`.

Manual: `test/test_page.html` exercises iframes, shadow DOM, modal dialogs, fullscreen, nested scrolling, form fields, and a DOM-mutation stressor.

## Known limits

- `chrome://` pages, the Web Store, and the browser UI can't be injected (platform restriction).
- **Closed** shadow roots are unreachable by design.
- OS-level whole-screen capture is invisible to extensions — use `Alt+Shift+P`.
- Cross-origin (tainted) canvases/images are skipped safely.
- NER model is ~66MB; OCR engine ~15MB. Both are opt-in toggles in Options → AI/OCR Modules.
