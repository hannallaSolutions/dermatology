#!/usr/bin/env node
/**
 * Production build for the California Rheumatology Institute static site.
 *
 * Reads only the 11 intended production HTML pages, traces every local asset
 * they (and their CSS/JS) actually reference, and writes a minified,
 * content-hashed, conservatively-obfuscated copy to dist/. Source files under
 * the repo root are only ever READ by this script, never written to.
 *
 * Run: node build.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CleanCSS = require('clean-css');
const { minify: terserMinify } = require('terser');
const JavaScriptObfuscator = require('javascript-obfuscator');
const { minify: htmlMinify } = require('html-minifier-terser');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// ---------------------------------------------------------------------------
// 1. Production page manifest (exact list requested)
// ---------------------------------------------------------------------------
const PRODUCTION_PAGES = [
  'index.html',
  'about.html',
  'services.html',
  'fq.html',
  'blog.html',
  'pat-resources.html',
  'contact.html',
  'locations.html',
  'patient.html',
  'appointment.html',
  'closest-loc.html',
];

// Deterministic seed for javascript-obfuscator. Fixed so repeat builds of
// unchanged source produce byte-identical output.
const OBFUSCATION_SEED = 738219455;

// Global function/variable names that are invoked from inline HTML attributes
// (onclick/onsubmit/onchange) or that must remain stable for readability of
// integration wiring. Verified by grepping on*="..." across all 11 pages.
const RESERVED_GLOBAL_NAMES = [
  '^toggleFAQ$',            // fq.html onclick
  '^toggleDetails$',        // services.html onclick (defined inline in services.html)
  '^sendEmail$',            // appointment.html onsubmit -- NOT DEFINED ANYWHERE (see report)
  '^findNearestFromInput$', // closest-loc.html onclick (js/loc.js)
  '^getUserLocation$',      // closest-loc.html onclick (js/loc.js)
  '^findNearest$',          // js/loc.js internal
  '^getDistance$',          // js/loc.js internal
  '^getCoordinates$',       // js/loc.js internal
  '^populateLocations$',    // js/loc.js internal
  '^highlightNearest$',     // js/loc.js internal
  '^showLocationDeniedFallback$', // js/loc.js internal
  '^locations$',            // js/loc.js data array
  '^locationsOLD$',         // js/loc.js dead data array (kept named, harmless)
  '^init$',                 // js/google-map.js Maps init, called via addDomListener
  '^google$',               // js/google-map.js var referencing the Maps global
];

// Inline <script> blocks containing any of these are minified only, never
// obfuscated -- they carry EmailJS / Google Maps integration identifiers that
// must be verifiably unchanged.
const INTEGRATION_CRITICAL_RE = /emailjs|AIzaSy|maps\.googleapis|sendForm|service_[a-z0-9]+|template_[a-z0-9]+/i;

// Vendor JS/CSS filename patterns -- copied verbatim, never minified further,
// never renamed/hashed, never obfuscated.
const VENDOR_JS_RE = /(^|\/)(jquery[^/]*|bootstrap[^/]*|popper[^/]*|owl\.carousel[^/]*|jquery\.magnific-popup[^/]*|aos\.js|jquery\.animateNumber[^/]*|bootstrap-datepicker\.js|jquery\.timepicker[^/]*|scrollax[^/]*|jquery\.waypoints[^/]*|jquery\.stellar[^/]*|jquery\.easing[^/]*)$/i;
const VENDOR_CSS_RE = /(^|\/)(bootstrap[^/]*|animate\.css|owl\.carousel[^/]*|owl\.theme[^/]*|magnific-popup\.css|aos\.css|ionicons[^/]*|bootstrap-datepicker\.css|jquery\.timepicker\.css|flaticon\.css|icomoon\.css|open-iconic-bootstrap[^/]*)$/i;

const LOCAL_URL_RE = /^(?!https?:\/\/|\/\/|data:|mailto:|tel:|javascript:|#)(.+)$/i;

// ---------------------------------------------------------------------------
// 1a. Confirmed-dead references (verified during Stage 1.5 review; each one
// documented below with how it was confirmed dead). These are applied to an
// in-memory copy only -- SOURCE FILES ARE NEVER WRITTEN TO. Applying the fix
// here (once) instead of via a verifier allowlist means the fixed pages/CSS
// never contain the missing reference in the first place, so the generic
// crawl-checker needs zero special-casing to report a clean pass.
// ---------------------------------------------------------------------------

// A. closest-loc.html loads a root-level "script.js" that never existed in
// git history (`git log --all -- script.js` returns nothing) and sits
// between two empty placeholder elements from early scaffolding. The page's
// entire closest-location feature (form handlers, distance calculation,
// result rendering) is fully implemented by js/loc.js, which the same page
// also loads directly below it. Confirmed dead and redundant -> removed from
// production output only.
const DEAD_SCRIPT_TAG_RE = /\s*<script\s+src=["']script\.js["']\s*>\s*<\/script>\s*/i;

function applyKnownDeadReferenceFixes(page, html) {
  if (page === 'closest-loc.html' && DEAD_SCRIPT_TAG_RE.test(html)) {
    return html.replace(DEAD_SCRIPT_TAG_RE, '\n');
  }
  return html;
}

// B. css/owl.carousel.min.css (vendor) ships a background-image reference to
// an "owl.video.play.png" icon for OwlCarousel's optional video-lightbox
// feature. Confirmed via grep across all 11 production pages, js/main.js,
// and scripts/fq.js for "owl-video", "videoUrl", a `video:` init option, and
// data-vimeo/data-youtube attributes: the video feature is never used
// anywhere on this site. The referenced PNG has never existed in this repo.
// Patch removes only that one dead url() reference; every other vendor rule
// in the file is byte-identical to source.
function applyKnownVendorCssFixes(relPath, text) {
  if (relPath === 'css/owl.carousel.min.css') {
    return text.replace('url(owl.video.play.png)', 'none');
  }
  return text;
}

// C. updated-styles/index.css defines `.lazy-bg.loaded { background-image:
// url('images/learnmore.jpg'); }` with a relative path that (from that
// file's own directory) resolves to the nonexistent updated-styles/images/.
// Confirmed provably dead, not merely "overridden": grepping all 11
// production pages and every first-party JS file for the class "lazy-bg"
// finds zero elements with that class and no script that ever adds it, so
// this selector can never match anything -- it is not a lazy-load feature
// that is "on pause", it was never wired to any element. Per instructions,
// a provably-dead rule is removed (not path-corrected, which would imply
// reviving an intended-but-unbuilt feature).
const DEAD_LAZY_BG_RULE_RE = /\.lazy-bg\.loaded\s*\{\s*background-image\s*:\s*url\(['"]?images\/learnmore\.jpg['"]?\)\s*;?\s*\}/i;

function applyKnownFirstPartyCssFixes(relPath, text) {
  if (relPath === 'updated-styles/index.css') {
    return text.replace(DEAD_LAZY_BG_RULE_RE, '');
  }
  return text;
}

function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function isLocalUrl(u) {
  if (!u) return false;
  u = u.trim();
  if (!u) return false;
  return LOCAL_URL_RE.test(u);
}

function stripQueryHash(u) {
  return u.split('#')[0].split('?')[0];
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

function ensureDirFor(relPath) {
  const dir = path.dirname(path.join(DIST, relPath));
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeRelPath(fromFileRelDir, refPath) {
  // Resolve a reference (possibly with ../) relative to the directory of the
  // file that referenced it, back to a repo-root-relative posix path.
  const resolved = path.posix.normalize(path.posix.join(fromFileRelDir, refPath));
  return resolved.replace(/^(\.\.\/)+/, ''); // guard against escaping repo root
}

// ---------------------------------------------------------------------------
// 2. Reference tracing
// ---------------------------------------------------------------------------

const ATTR_REF_RE = /\b(?:href|src|poster)\s*=\s*"([^"]*)"|\b(?:href|src|poster)\s*=\s*'([^']*)'/gi;
const SRCSET_RE = /\bsrcset\s*=\s*"([^"]*)"|\bsrcset\s*=\s*'([^']*)'/gi;
const STYLE_ATTR_RE = /\bstyle\s*=\s*"([^"]*)"|\bstyle\s*=\s*'([^']*)'/gi;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:url\()?['"]?([^'")\s;]+)['"]?\)?/gi;
const JS_IMAGE_STRING_RE = /(['"])((?:\.\.\/|images\/|fonts\/)[^'"]+\.(?:png|jpe?g|webp|gif|svg|ico))\1/gi;

function extractCssUrlsFromText(cssText, cssFileRelDir) {
  const out = new Set();
  let m;
  CSS_URL_RE.lastIndex = 0;
  while ((m = CSS_URL_RE.exec(cssText))) {
    const raw = m[2];
    if (!isLocalUrl(raw)) continue;
    out.add(normalizeRelPath(cssFileRelDir, stripQueryHash(raw)));
  }
  CSS_IMPORT_RE.lastIndex = 0;
  while ((m = CSS_IMPORT_RE.exec(cssText))) {
    const raw = m[1];
    if (!isLocalUrl(raw)) continue;
    out.add(normalizeRelPath(cssFileRelDir, stripQueryHash(raw)));
  }
  return out;
}

/**
 * Read a production page and apply confirmed-dead-reference fixes (in memory
 * only). Both the tracer and the final HTML-writing pass call this so they
 * always operate on identical content and never diverge.
 */
function loadEffectivePageHtml(page) {
  const raw = fs.readFileSync(path.join(ROOT, page), 'utf8');
  return applyKnownDeadReferenceFixes(page, raw);
}

/**
 * Walk the 11 production pages and everything they reference (including
 * transitively, through CSS url()/@import chains and known JS image-string
 * literals) to build the exact whitelist of files dist/ needs.
 *
 * HTML comments are stripped before scanning for references, so content that
 * is authored but disabled (e.g. a <!-- ... --> block) is never treated as a
 * live production dependency -- it matches what will actually be shipped,
 * since html-minifier-terser removes the same comments from dist/ output.
 */
function traceRequiredAssets() {
  const htmlAttrRefs = new Map(); // page -> Set(localRefs)
  const cssFiles = new Set();
  const jsFiles = new Set();
  const otherAssets = new Set(); // images, fonts, pdf, etc.
  const brokenRefs = []; // { page, ref, reason }

  for (const page of PRODUCTION_PAGES) {
    if (!fileExists(page)) {
      throw new Error(`Production page listed but missing from source: ${page}`);
    }
    const html = stripHtmlComments(loadEffectivePageHtml(page));
    const refs = new Set();

    let m;
    ATTR_REF_RE.lastIndex = 0;
    while ((m = ATTR_REF_RE.exec(html))) {
      const val = m[1] !== undefined ? m[1] : m[2];
      if (isLocalUrl(val)) refs.add(stripQueryHash(val));
    }
    SRCSET_RE.lastIndex = 0;
    while ((m = SRCSET_RE.exec(html))) {
      const val = m[1] !== undefined ? m[1] : m[2];
      val.split(',').forEach((entry) => {
        const url = entry.trim().split(/\s+/)[0];
        if (isLocalUrl(url)) refs.add(stripQueryHash(url));
      });
    }
    STYLE_ATTR_RE.lastIndex = 0;
    while ((m = STYLE_ATTR_RE.exec(html))) {
      const val = m[1] !== undefined ? m[1] : m[2];
      const urls = extractCssUrlsFromText(val, '');
      urls.forEach((u) => refs.add(u));
    }
    STYLE_BLOCK_RE.lastIndex = 0;
    while ((m = STYLE_BLOCK_RE.exec(html))) {
      const urls = extractCssUrlsFromText(m[1], '');
      urls.forEach((u) => refs.add(u));
    }
    SCRIPT_BLOCK_RE.lastIndex = 0;
    while ((m = SCRIPT_BLOCK_RE.exec(html))) {
      const attrs = m[1];
      if (/\bsrc\s*=/.test(attrs)) continue; // external, already caught above
      const body = m[2];
      let jm;
      JS_IMAGE_STRING_RE.lastIndex = 0;
      while ((jm = JS_IMAGE_STRING_RE.exec(body))) {
        refs.add(stripQueryHash(jm[2]));
      }
    }

    htmlAttrRefs.set(page, refs);

    for (const ref of refs) {
      const rel = normalizeRelPath('', ref);
      if (rel.endsWith('.html')) {
        if (!PRODUCTION_PAGES.includes(rel)) {
          brokenRefs.push({ page, ref, reason: 'references a non-production/nonexistent HTML page' });
        }
        continue;
      }
      if (rel.endsWith('.css')) { cssFiles.add(rel); continue; }
      if (rel.endsWith('.js')) { jsFiles.add(rel); continue; }
      otherAssets.add(rel);
    }
  }

  // Transitively resolve CSS -> (fonts/images, nested CSS via @import)
  const cssQueue = Array.from(cssFiles);
  const seenCss = new Set(cssQueue);
  while (cssQueue.length) {
    const cssRel = cssQueue.shift();
    if (!fileExists(cssRel)) {
      brokenRefs.push({ page: '(css)', ref: cssRel, reason: 'referenced CSS file does not exist' });
      continue;
    }
    let cssText = fs.readFileSync(path.join(ROOT, cssRel), 'utf8');
    // Apply the same confirmed-dead-reference fixes the builder applies, so
    // the tracer and the actual dist output agree on what's required. Each
    // fix only matches its own specific relPath, so applying both is a no-op
    // for every other file.
    cssText = applyKnownVendorCssFixes(cssRel, cssText);
    cssText = applyKnownFirstPartyCssFixes(cssRel, cssText);
    const cssDir = path.posix.dirname(cssRel);
    const urls = extractCssUrlsFromText(cssText, cssDir);
    for (const u of urls) {
      if (u.endsWith('.css')) {
        if (!seenCss.has(u)) { seenCss.add(u); cssFiles.add(u); cssQueue.push(u); }
      } else {
        otherAssets.add(u);
      }
    }
  }

  // JS -> image string literals (covers js/google-map.js's 'images/loc.png')
  for (const jsRel of jsFiles) {
    if (!fileExists(jsRel)) {
      brokenRefs.push({ page: '(js)', ref: jsRel, reason: 'referenced JS file does not exist' });
      continue;
    }
    const jsText = fs.readFileSync(path.join(ROOT, jsRel), 'utf8');
    let jm;
    JS_IMAGE_STRING_RE.lastIndex = 0;
    while ((jm = JS_IMAGE_STRING_RE.exec(jsText))) {
      otherAssets.add(stripQueryHash(jm[2]));
    }
  }

  // Validate "otherAssets" existence now (images/fonts/etc.)
  const missingOther = [];
  for (const a of otherAssets) {
    if (!fileExists(a)) missingOther.push(a);
  }
  missingOther.forEach((a) => brokenRefs.push({ page: '(asset)', ref: a, reason: 'referenced asset does not exist on disk' }));

  return { htmlAttrRefs, cssFiles, jsFiles, otherAssets, brokenRefs, missingOther };
}

// ---------------------------------------------------------------------------
// 3. Minify / obfuscate / hash first-party CSS & JS
// ---------------------------------------------------------------------------

// Shared config so terser/obfuscator settings exist in exactly one place
// (used by first-party external files below AND by inline-script handling).
const MANGLE_RESERVED = RESERVED_GLOBAL_NAMES.map((r) => r.replace(/^\^|\$$/g, ''));

function terserOptions() {
  return {
    compress: { drop_console: true, drop_debugger: true },
    mangle: { reserved: MANGLE_RESERVED },
    format: { comments: false },
  };
}

function obfuscatorOptions() {
  return {
    compact: true,
    simplify: true,
    target: 'browser',
    seed: OBFUSCATION_SEED,
    sourceMap: false,
    renameGlobals: false,
    reservedNames: RESERVED_GLOBAL_NAMES,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    selfDefending: false,
    splitStrings: false,
    numbersToExpressions: false,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    rotateStringArray: true,
    identifierNamesGenerator: 'hexadecimal',
  };
}

function obfuscateCode(code) {
  return JavaScriptObfuscator.obfuscate(code, obfuscatorOptions()).getObfuscatedCode();
}

function hashAndPlace(relPath, outText, isVendor) {
  const hash = sha256Hex(Buffer.from(outText, 'utf8')).slice(0, 10);
  const dir = path.posix.dirname(relPath);
  const ext = path.posix.extname(relPath);
  const base = path.posix.basename(relPath, ext);
  const outRel = isVendor ? relPath : path.posix.join(dir, `${base}.${hash}${ext}`);
  return { relPath, outRel, outText, isVendor, hash: isVendor ? null : hash };
}

async function buildCssAsset(relPath) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const isVendor = VENDOR_CSS_RE.test(relPath);
  let outText;
  if (isVendor) {
    outText = applyKnownVendorCssFixes(relPath, src); // verbatim except confirmed dead-asset patches
  } else {
    const patched = applyKnownFirstPartyCssFixes(relPath, src);
    const result = new CleanCSS({ level: 1, returnPromise: false }).minify(patched);
    outText = result.styles;
  }
  return hashAndPlace(relPath, outText, isVendor);
}

async function buildJsAsset(relPath) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const isVendor = VENDOR_JS_RE.test(relPath);
  let outText;
  if (isVendor) {
    outText = src; // copy verbatim
  } else {
    const minified = await terserMinify(src, terserOptions());
    if (!minified.code) throw new Error(`terser produced no output for ${relPath}`);
    outText = obfuscateCode(minified.code);
  }
  return hashAndPlace(relPath, outText, isVendor);
}

// ---------------------------------------------------------------------------
// 4. Per-page inline <style>/<script> minification (+ conservative obfuscation)
// ---------------------------------------------------------------------------

function minifyInlineCss(cssText) {
  try {
    const result = new CleanCSS({ level: 1, returnPromise: false }).minify(cssText);
    return result.styles;
  } catch (e) {
    return cssText; // never fail the build over an inline <style> block
  }
}

async function minifyAndMaybeObfuscateInlineJs(jsText) {
  const trimmed = jsText.trim();
  if (!trimmed) return jsText;
  const criticalHere = INTEGRATION_CRITICAL_RE.test(jsText);
  let minified;
  try {
    const result = await terserMinify(jsText, terserOptions());
    minified = result.code || jsText;
  } catch (e) {
    minified = jsText; // fall back to original if terser can't parse a fragment
  }
  if (criticalHere) {
    return minified; // minify only -- never obfuscate EmailJS/Maps-bearing inline code
  }
  try {
    return obfuscateCode(minified);
  } catch (e) {
    return minified; // fall back to minified-only if obfuscation of this fragment fails
  }
}

async function processInlineBlocks(html) {
  // Inline <style> blocks
  let out = '';
  let lastIndex = 0;
  const styleMatches = [];
  {
    let m;
    STYLE_BLOCK_RE.lastIndex = 0;
    while ((m = STYLE_BLOCK_RE.exec(html))) {
      styleMatches.push({ start: m.index, end: m.index + m[0].length, full: m[0], content: m[1] });
    }
  }
  for (const sm of styleMatches) {
    out += html.slice(lastIndex, sm.start);
    const openTagEnd = sm.full.indexOf('>') + 1;
    const openTag = sm.full.slice(0, openTagEnd);
    const minified = minifyInlineCss(sm.content);
    out += `${openTag}${minified}</style>`;
    lastIndex = sm.end;
  }
  out += html.slice(lastIndex);
  html = out;

  // Inline <script> blocks (only those without a src attribute)
  out = '';
  lastIndex = 0;
  const scriptMatches = [];
  {
    let m;
    SCRIPT_BLOCK_RE.lastIndex = 0;
    while ((m = SCRIPT_BLOCK_RE.exec(html))) {
      const attrs = m[1];
      const hasSrc = /\bsrc\s*=/.test(attrs);
      const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
      const type = typeMatch ? typeMatch[1].toLowerCase() : null;
      const isJsType = !type || type.includes('javascript') || type === 'module' || type === 'text/babel';
      scriptMatches.push({
        start: m.index,
        end: m.index + m[0].length,
        full: m[0],
        attrs,
        content: m[2],
        eligible: !hasSrc && isJsType,
      });
    }
  }
  for (const sm of scriptMatches) {
    out += html.slice(lastIndex, sm.start);
    if (sm.eligible && sm.content.trim()) {
      const openTagEnd = sm.full.indexOf('>') + 1;
      const openTag = sm.full.slice(0, openTagEnd);
      const processed = await minifyAndMaybeObfuscateInlineJs(sm.content);
      out += `${openTag}${processed}</script>`;
    } else {
      out += sm.full;
    }
    lastIndex = sm.end;
  }
  out += html.slice(lastIndex);
  return out;
}

// ---------------------------------------------------------------------------
// 5. Main build
// ---------------------------------------------------------------------------

async function main() {
  console.log('== California Rheumatology Institute -- production build ==');

  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST, { recursive: true });

  console.log('\n[1/6] Tracing references from the 11 production pages...');
  console.log('  Confirmed-dead-reference fixes applied (in-memory, dist-only; source untouched):');
  console.log('    - closest-loc.html: removed <script src="script.js"> (never existed; superseded by js/loc.js)');
  console.log('    - css/owl.carousel.min.css: removed dead url(owl.video.play.png) (video feature unused site-wide)');
  console.log('    - updated-styles/index.css: removed dead .lazy-bg.loaded rule (class never used on any page)');
  console.log('    - HTML comments are stripped before reference tracing (commented-out/dead markup is never treated as a required production reference)');
  const trace = traceRequiredAssets();
  console.log(`  CSS files referenced: ${trace.cssFiles.size}`);
  console.log(`  JS files referenced:  ${trace.jsFiles.size}`);
  console.log(`  Other local assets:   ${trace.otherAssets.size}`);
  if (trace.brokenRefs.length) {
    console.log(`  Remaining unresolved references found (${trace.brokenRefs.length}) -- these are NOT allowlisted and WILL fail verify-dist.js:`);
    trace.brokenRefs.forEach((b) => console.log(`    - [${b.page}] "${b.ref}" -- ${b.reason}`));
  } else {
    console.log('  No unresolved references found.');
  }

  console.log('\n[2/6] Building first-party CSS/JS (minify + hash; obfuscate first-party JS)...');
  const cssMap = new Map(); // oldRel -> {outRel, isVendor, hash}
  for (const rel of trace.cssFiles) {
    if (!fileExists(rel)) continue; // already reported as broken above
    const built = await buildCssAsset(rel);
    cssMap.set(rel, built);
  }
  const jsMap = new Map();
  for (const rel of trace.jsFiles) {
    if (!fileExists(rel)) continue;
    const built = await buildJsAsset(rel);
    jsMap.set(rel, built);
  }
  const firstPartyCss = Array.from(cssMap.values()).filter((v) => !v.isVendor);
  const firstPartyJs = Array.from(jsMap.values()).filter((v) => !v.isVendor);
  firstPartyCss.forEach((v) => console.log(`  CSS  ${v.relPath}  ->  ${v.outRel}`));
  firstPartyJs.forEach((v) => console.log(`  JS   ${v.relPath}  ->  ${v.outRel}  (obfuscated)`));

  console.log('\n[3/6] Writing CSS/JS/asset files to dist/...');
  for (const built of cssMap.values()) {
    ensureDirFor(built.outRel);
    fs.writeFileSync(path.join(DIST, built.outRel), built.outText, 'utf8');
  }
  for (const built of jsMap.values()) {
    ensureDirFor(built.outRel);
    fs.writeFileSync(path.join(DIST, built.outRel), built.outText, 'utf8');
  }
  let copiedAssets = 0;
  for (const rel of trace.otherAssets) {
    if (!fileExists(rel)) continue; // reported as broken above
    ensureDirFor(rel);
    fs.copyFileSync(path.join(ROOT, rel), path.join(DIST, rel));
    copiedAssets++;
  }
  console.log(`  Copied ${copiedAssets} image/font/misc assets verbatim.`);

  console.log('\n[4/6] Rewriting HTML pages (asset paths, inline CSS/JS, structural minify)...');
  const htmlMinifyOptions = {
    collapseWhitespace: true,
    conservativeCollapse: false,
    removeComments: true,
    removeEmptyAttributes: false,
    removeRedundantAttributes: false,
    removeScriptTypeAttributes: false,
    removeStyleLinkTypeAttributes: false,
    useShortDoctype: false,
    keepClosingSlash: true,
    caseSensitive: true,
    minifyCSS: false, // already handled explicitly above
    minifyJS: false, // already handled explicitly above (avoids re-parsing obfuscated code)
    html5: true,
  };

  const sizeReport = [];
  for (const page of PRODUCTION_PAGES) {
    const originalSource = fs.readFileSync(path.join(ROOT, page), 'utf8');
    let html = loadEffectivePageHtml(page); // applies confirmed dead-reference fixes, in memory only

    // Rewrite first-party CSS/JS references to their hashed filenames.
    // Vendor entries map to themselves (outRel === relPath), so this is safe
    // to run unconditionally over the full css+js map.
    for (const built of [...cssMap.values(), ...jsMap.values()]) {
      if (built.outRel === built.relPath) continue;
      const re = new RegExp(`(["'])${escapeRegex(built.relPath)}\\1`, 'g');
      html = html.replace(re, (_, q) => `${q}${built.outRel}${q}`);
    }

    html = await processInlineBlocks(html);

    let minified;
    try {
      minified = await htmlMinify(html, htmlMinifyOptions);
    } catch (e) {
      console.warn(`  WARNING: html-minifier-terser failed on ${page} (${e.message}); writing unminified-structure HTML for this page only.`);
      minified = html;
    }

    ensureDirFor(page);
    fs.writeFileSync(path.join(DIST, page), minified, 'utf8');
    sizeReport.push({ page, before: Buffer.byteLength(originalSource, 'utf8'), after: Buffer.byteLength(minified, 'utf8') });
  }

  console.log('\n[5/6] Build summary');
  let totalBefore = 0;
  let totalAfter = 0;
  for (const r of sizeReport) {
    totalBefore += r.before;
    totalAfter += r.after;
    console.log(`  ${r.page.padEnd(20)} ${r.before.toString().padStart(8)} B -> ${r.after.toString().padStart(8)} B`);
  }
  console.log(`  ${'TOTAL (11 HTML)'.padEnd(20)} ${totalBefore.toString().padStart(8)} B -> ${totalAfter.toString().padStart(8)} B`);

  console.log('\n[6/6] Done. Run "node verify-dist.js" to crawl-check dist/.');

  // Persist a manifest for the verifier / report. Written OUTSIDE dist/ so
  // dist/ contains only production pages and the assets they require.
  fs.writeFileSync(
    path.join(ROOT, 'dist-manifest.json'),
    JSON.stringify(
      {
        pages: PRODUCTION_PAGES,
        cssMap: Array.from(cssMap.entries()).map(([k, v]) => [k, v.outRel, v.isVendor]),
        jsMap: Array.from(jsMap.entries()).map(([k, v]) => [k, v.outRel, v.isVendor]),
        assets: Array.from(trace.otherAssets),
        brokenRefs: trace.brokenRefs,
        sizeReport,
        totalBefore,
        totalAfter,
        seed: OBFUSCATION_SEED,
      },
      null,
      2
    ),
    'utf8'
  );
}

main().catch((err) => {
  console.error('BUILD FAILED:', err);
  process.exit(1);
});
