#!/usr/bin/env node
/**
 * Strict crawl-check for dist/. Walks the 11 production pages, follows every
 * local href/src/srcset/poster/CSS url()/@import/JS-known asset reference,
 * and reports any that don't resolve inside dist/. Also checks that orphan
 * pages, dev tooling files, source maps, and unhashed first-party CSS/JS are
 * absent. Read-only; does not modify dist/.
 *
 * IMPORTANT: this checker has NO allowlist of known-missing resources. Every
 * reference it finds must resolve inside dist/, full stop. Previously-known
 * gaps (a dead <script src="script.js">, a dead vendor CSS background-image,
 * a dead CSS rule, and a commented-out PDF section) were fixed at the source
 * of the problem in build.js (dead references removed from production
 * output, HTML comments stripped before tracing) specifically so this file
 * does not need to special-case them. If a genuinely new missing resource
 * appears, this script MUST fail loudly, not warn quietly.
 *
 * Run: node verify-dist.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

const PRODUCTION_PAGES = [
  'index.html', 'about.html', 'services.html', 'fq.html', 'blog.html',
  'pat-resources.html', 'contact.html', 'locations.html', 'patient.html',
  'appointment.html', 'closest-loc.html',
];

const ORPHAN_PAGES = [
  'blog-single.html', 'dd.html', 'doctor.html', 'in.html', 'learn.html',
  'pricing.html', 'providers.html', 'send.html', 'department.html',
];

// Dev/tooling/source paths that must never appear inside dist/.
const FORBIDDEN_PATHS = [
  'scss', '.vscode', '.DS_Store', 'prepros-6.config', 'package.json',
  'package-lock.json', 'build.js', 'verify-dist.js', 'serve-dist.js',
  'node_modules', '.git', 'updated-styles/res.css', 'dist-manifest.json',
  '.env', '.env.local', '.env.production', 'logs', 'backup', 'backups',
  '.idea', '.editorconfig',
];

const ATTR_REF_RE = /\b(?:href|src|poster)\s*=\s*"([^"]*)"|\b(?:href|src|poster)\s*=\s*'([^']*)'/gi;
const SRCSET_RE = /\bsrcset\s*=\s*"([^"]*)"|\bsrcset\s*=\s*'([^']*)'/gi;
const STYLE_ATTR_RE = /\bstyle\s*=\s*"([^"]*)"|\bstyle\s*=\s*'([^']*)'/gi;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:url\()?['"]?([^'")\s;]+)['"]?\)?/gi;
const JS_IMAGE_STRING_RE = /(['"])((?:\.\.\/|images\/|fonts\/)[^'"]+\.(?:png|jpe?g|webp|gif|svg|ico))\1/gi;
const LOCAL_URL_RE = /^(?!https?:\/\/|\/\/|data:|mailto:|tel:|javascript:|#)(.+)$/i;

function isLocalUrl(u) {
  if (!u) return false;
  u = u.trim();
  return !!u && LOCAL_URL_RE.test(u);
}
function stripQueryHash(u) { return u.split('#')[0].split('?')[0]; }
function stripHtmlComments(html) { return html.replace(/<!--[\s\S]*?-->/g, ''); }
function normalizeRelPath(fromDir, refPath) {
  const resolved = path.posix.normalize(path.posix.join(fromDir, refPath));
  return resolved.replace(/^(\.\.\/)+/, '');
}
function extractCssUrls(cssText, cssDir) {
  const out = new Set();
  let m;
  CSS_URL_RE.lastIndex = 0;
  while ((m = CSS_URL_RE.exec(cssText))) {
    if (isLocalUrl(m[2])) out.add(normalizeRelPath(cssDir, stripQueryHash(m[2])));
  }
  CSS_IMPORT_RE.lastIndex = 0;
  while ((m = CSS_IMPORT_RE.exec(cssText))) {
    if (isLocalUrl(m[1])) out.add(normalizeRelPath(cssDir, stripQueryHash(m[1])));
  }
  return out;
}

let errors = 0;
let missingResourceCount = 0;
function fail(msg) { console.log(`  MISSING/BROKEN: ${msg}`); errors++; missingResourceCount++; }
function ok(msg) { console.log(`  OK: ${msg}`); }

console.log('== dist/ strict crawl-check (no allowlist) ==\n');

if (!fs.existsSync(DIST)) {
  console.error('dist/ does not exist. Run "node build.js" first.');
  process.exit(1);
}

// 1. Orphan pages / forbidden paths absence
console.log('[1] Orphan pages and forbidden files/folders');
for (const p of ORPHAN_PAGES) {
  if (fs.existsSync(path.join(DIST, p))) fail(`orphan page present in dist/: ${p}`);
  else ok(`absent: ${p}`);
}
for (const p of FORBIDDEN_PATHS) {
  if (fs.existsSync(path.join(DIST, p))) fail(`forbidden path present in dist/: ${p}`);
  else ok(`absent: ${p}`);
}
function walk(dir, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb);
    else cb(full);
  }
}
let mapFound = false;
walk(DIST, (f) => { if (f.endsWith('.map')) { fail(`source map present: ${path.relative(DIST, f)}`); mapFound = true; } });
if (!mapFound) ok('no .map files found anywhere in dist/');

// 2. Unhashed first-party CSS/JS absence
console.log('\n[2] Unhashed first-party CSS/JS filenames must be absent');
const UNHASHED_FIRST_PARTY = ['css/style.css', 'updates.css', 'js/main.js', 'js/google-map.js', 'js/loc.js', 'scripts/fq.js'];
for (const rel of UNHASHED_FIRST_PARTY) {
  if (fs.existsSync(path.join(DIST, rel))) fail(`unhashed first-party file present: ${rel}`);
  else ok(`absent (hashed instead): ${rel}`);
}
if (fs.existsSync(path.join(DIST, 'updated-styles'))) {
  for (const f of fs.readdirSync(path.join(DIST, 'updated-styles'))) {
    if (!/\.[0-9a-f]{10}\.css$/.test(f)) fail(`updated-styles/${f} does not look content-hashed`);
    else ok(`hashed: updated-styles/${f}`);
  }
}

// 3. Crawl the 11 production pages -- every local reference must resolve.
// No special-casing, no allowlist: a reference either resolves inside
// dist/, or it is reported as MISSING/BROKEN.
console.log('\n[3] Crawling all 11 production pages for local references (comments stripped first)');
for (const page of PRODUCTION_PAGES) {
  const full = path.join(DIST, page);
  if (!fs.existsSync(full)) { fail(`production page missing from dist/: ${page}`); continue; }
  const rawHtml = fs.readFileSync(full, 'utf8');
  const html = stripHtmlComments(rawHtml);
  const refs = new Set();

  let m;
  ATTR_REF_RE.lastIndex = 0;
  while ((m = ATTR_REF_RE.exec(html))) {
    const v = m[1] !== undefined ? m[1] : m[2];
    if (isLocalUrl(v)) refs.add(stripQueryHash(v));
  }
  SRCSET_RE.lastIndex = 0;
  while ((m = SRCSET_RE.exec(html))) {
    const v = m[1] !== undefined ? m[1] : m[2];
    v.split(',').forEach((entry) => {
      const url = entry.trim().split(/\s+/)[0];
      if (isLocalUrl(url)) refs.add(stripQueryHash(url));
    });
  }
  STYLE_ATTR_RE.lastIndex = 0;
  while ((m = STYLE_ATTR_RE.exec(html))) {
    extractCssUrls(m[1] !== undefined ? m[1] : m[2], '').forEach((u) => refs.add(u));
  }
  STYLE_BLOCK_RE.lastIndex = 0;
  while ((m = STYLE_BLOCK_RE.exec(html))) {
    extractCssUrls(m[1], '').forEach((u) => refs.add(u));
  }
  SCRIPT_BLOCK_RE.lastIndex = 0;
  while ((m = SCRIPT_BLOCK_RE.exec(html))) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    let jm;
    JS_IMAGE_STRING_RE.lastIndex = 0;
    while ((jm = JS_IMAGE_STRING_RE.exec(m[2]))) refs.add(stripQueryHash(jm[2]));
  }

  let pageMissing = 0;
  for (const ref of refs) {
    const rel = normalizeRelPath('', ref);
    if (rel.endsWith('.html')) {
      if (!PRODUCTION_PAGES.includes(rel)) {
        fail(`${page} references non-production page "${rel}"`);
        pageMissing++;
      }
      continue;
    }
    if (!fs.existsSync(path.join(DIST, rel))) {
      fail(`${page} references missing local resource "${rel}"`);
      pageMissing++;
    }
  }

  // Also resolve CSS files this page links to, and check THEIR url()s exist.
  ATTR_REF_RE.lastIndex = 0;
  const cssRefs = [];
  while ((m = ATTR_REF_RE.exec(html))) {
    const v = m[1] !== undefined ? m[1] : m[2];
    if (isLocalUrl(v) && stripQueryHash(v).endsWith('.css')) cssRefs.push(stripQueryHash(v));
  }
  for (const cssRel of cssRefs) {
    const cssFull = path.join(DIST, cssRel);
    if (!fs.existsSync(cssFull)) continue; // already reported above
    const cssText = fs.readFileSync(cssFull, 'utf8');
    const cssDir = path.posix.dirname(cssRel);
    const urls = extractCssUrls(cssText, cssDir);
    for (const u of urls) {
      if (!fs.existsSync(path.join(DIST, u))) {
        fail(`${page} -> ${cssRel} references missing "${u}"`);
        pageMissing++;
      }
    }
  }

  if (pageMissing === 0) ok(`${page}: all local references resolve`);
}

console.log(`\n== Result: ${errors} error(s), ${missingResourceCount} missing-resource warning(s) ==`);
process.exit(errors > 0 ? 1 : 0);
