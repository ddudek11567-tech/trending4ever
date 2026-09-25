#!/usr/bin/env node
/**
 * Fullxcinema "Best Movies" picker
 * Ranks full-length movies on fullxcinema.com/category/porn-movies-online/
 * by popularity (views x rating) across most-viewed + popular listings,
 * extracts each movie's direct MP4 (clean-tube-player iframe), verifies it,
 * then appends up to 10 verified films to adult-tv.html and adult.html.
 *
 * Usage: node fx_fullxcinema_movies.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const ROOT = __dirname;
const ADULT_TV = path.join(ROOT, 'adult-tv.html');
const ADULT_HTML = path.join(ROOT, 'adult.html');
const CATEGORY = 'https://fullxcinema.com/category/porn-movies-online';
const MAX_FILMS = 10;
const TOP_CANDIDATES = 20;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function log(msg) {
  console.log(msg);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url, opts) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA }, timeout: 20000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

function verifyMp4(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const u = new URL(url);
    const req = mod.get({
      hostname: u.hostname, path: u.pathname + u.search, headers: {
        'User-Agent': UA,
        'Range': 'bytes=0-4095',
      }, timeout: 25000,
    }, res => {
      let got = 0;
      res.on('data', c => got += c.length);
      res.on('end', () => {
        const ok = (res.statusCode === 200 || res.statusCode === 206) && got >= 1024;
        res.resume();
        resolve({ ok, status: res.statusCode, bytes: got, cl: res.headers['content-length'] || res.headers['content-range'] || '' });
      });
    });
    req.on('error', () => resolve({ ok: false, status: 0, bytes: 0, cl: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, bytes: 0, cl: '' }); });
  });
}

function parseViews(s) {
  if (!s) return 0;
  s = s.replace(/,/g, '').trim();
  const m = s.match(/([\d.]+)\s*(K|M)?/i);
  if (!m) return 0;
  let v = parseFloat(m[1]) || 0;
  if (m[2] && m[2].toUpperCase() === 'K') v *= 1e3;
  if (m[2] && m[2].toUpperCase() === 'M') v *= 1e6;
  return v;
}

function parseArticles(html) {
  const chunks = html.split(/<article\b/i).slice(1);
  const items = [];
  for (const c of chunks) {
    const id = (c.match(/data-post-id="(\d+)"/) || [])[1];
    if (!id) continue;
    const aHref = c.match(/<a href="(https:\/\/fullxcinema\.com\/[^"]+\/)" title="([^"]*)"/);
    if (!aHref) continue;
    const title = aHref[2].replace(/&amp;/g, '&').trim();
    const viewsRaw = (c.match(/class="views"[^<]*<i[^>]*><\/i>\s*([^<]+)</) || c.match(/class="views"[^>]*>(?:<i[^>]*><\/i>)?\s*([^<]+)</) || [])[1];
    const views = parseViews(viewsRaw);
    const rating = parseInt((c.match(/<span>(\d+)%<\/span>/) || [])[1], 10) || 0;
    const duration = (c.match(/class="duration"[^>]*>.*?([\d:]+)/) || [])[1] || '';
    const poster = (c.match(/data-main-thumb="([^"]+)"/) || c.match(/class="video-main-thumb"[^>]*src="([^"]+)"/) || [])[1] || '';
    items.push({ id, href: aHref[1], title, views, rating, duration, poster, score: views * (rating > 0 ? rating / 100 : 0.5) });
  }
  return items;
}

async function fetchListing(filter, page) {
  let url = CATEGORY;
  if (page > 1) url += `/page/${page}/`;
  url += `?filter=${filter}`;
  const { status, body } = await httpsGet(url);
  if (status !== 200) return [];
  return parseArticles(body);
}

function extractMp4(postHtml) {
  const iframe = postHtml.match(/player-x\.php\?q=([^"'&\s]+)/);
  if (!iframe) return null;
  let s1;
  try { s1 = decodeURIComponent(iframe[1]); } catch { return null; }
  let s2;
  try { s2 = Buffer.from(s1, 'base64').toString('utf8'); } catch { return null; }
  let s3;
  try { s3 = decodeURIComponent(s2); } catch { return null; }
  const src = (s3.match(/<source[^>]*src="([^"]+)"/) || [])[1];
  if (!src) return null;
  try { return decodeURIComponent(src); } catch { return src; }
}

function readFilmsArr(file) {
  const html = fs.readFileSync(file, 'utf8');
  const line = html.split('\n').find(l => l.includes('const FILMS=['));
  const firstB = line.indexOf('[');
  const lastSemicolon = line.lastIndexOf('];');
  const arrStr = line.slice(firstB, lastSemicolon + 1);
  let arr = JSON.parse(arrStr);
  if (arr.length === 1 && Array.isArray(arr[0])) arr = arr[0];
  return arr;
}

function patchFilms(file, toAdd) {
  let html = fs.readFileSync(file, 'utf8');
  const lines = html.split('\n');
  const idx = lines.findIndex(l => l.includes('const FILMS=['));
  if (idx < 0) throw new Error('FILMS line not found in ' + file);
  const filmLine = lines[idx];
  const firstB = filmLine.indexOf('[');
  const lastSemicolon = filmLine.lastIndexOf('];');
  const arrStr = filmLine.slice(firstB, lastSemicolon + 1);
  let arr = JSON.parse(arrStr);
  if (arr.length === 1 && Array.isArray(arr[0])) arr = arr[0];
  const nextId = arr.reduce((mx, x) => Math.max(mx, x.id || 0), 0) + 1;
  const withIds = toAdd.map((f, i) => ({ ...f, id: nextId + i }));
  const final = arr.concat(withIds);
  lines[idx] = 'const FILMS=' + JSON.stringify(final) + ';';
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return final.length;
}

async function main() {
  const fs_start = Date.now();
  log('=== Fullxcinema Best-Movies Update Started ===');

  const seen = new Map();
  const listings = [
    [['most-viewed', 1], ['most-viewed', 2], ['most-viewed', 3]],
    [['popular', 1], ['popular', 2]],
  ].flat();

  for (const [filter, page] of listings) {
    const items = await fetchListing(filter, page);
    log(`Listing ${filter} p${page}: ${items.length} items`);
    for (const it of items) {
      const prev = seen.get(it.id);
      if (!prev) seen.set(it.id, it);
    }
    await sleep(150);
  }

  const all = [...seen.values()].sort((a, b) => b.score - a.score);
  log(`Unique candidates: ${all.length}`);
  for (const it of all.slice(0, 10)) log(`  #${all.indexOf(it) + 1} ${it.title} | views=${it.views} rating=${it.rating}% score=${Math.round(it.score)}`);

  const existing = readFilmsArr(ADULT_TV);
  log(`Existing films: ${existing.length}`);
  const dupUrls = new Set(existing.map(f => f.video));
  const existingTitles = new Set(existing.map(f => f.title.toLowerCase()));

  const chosen = [];
  for (const it of all.slice(0, TOP_CANDIDATES)) {
    if (chosen.length >= MAX_FILMS) break;
    if (existingTitles.has(it.title.toLowerCase())) { log(`  skip (already have): ${it.title}`); continue; }

    let mp4 = null;
    try {
      const { status, body } = await httpsGet(it.href);
      if (status === 200) mp4 = extractMp4(body);
    } catch (e) { mp4 = null; }
    if (!mp4) { log(`  skip (no mp4 found): ${it.title}`); continue; }
    if (dupUrls.has(mp4)) { log(`  skip (dup url): ${it.title}`); continue; }
    const v = await verifyMp4(mp4);
    if (!v.ok) { log(`  skip (dead mp4 ${v.status} ${v.bytes}B): ${it.title} | ${mp4}`); continue; }

    const yearMatch = it.title.match(/\((\d{4})\)/);
    const film = {
      id: 0,
      title: it.title.replace(/\s*\(\d{4}\)\s*$/, '').trim(),
      year: yearMatch ? parseInt(yearMatch[1], 10) : 0,
      genreKey: 'adult',
      genreLabel: 'Adult',
      icon: '🔞',
      accent: '#b91c1c',
      rgb: '185,28,28',
      video: mp4,
      cats: ['adult'],
      img: it.poster,
      new: true,
    };
    chosen.push(film);
    dupUrls.add(mp4);
    existingTitles.add(film.title.toLowerCase());
    log(`  ADDED: ${film.title} (${yearMatch ? film.year : 'n/a'}) ${v.status} ${v.bytes}B | ${mp4}`);
    await sleep(100);
  }

  if (chosen.length === 0) { log('No new films found'); return; }
  log(`Adding ${chosen.length} films...`);
  const totalTV = patchFilms(ADULT_TV, chosen);
  const totalHTML = patchFilms(ADULT_HTML, chosen);
  log(`adult-tv.html total=${totalTV} | adult.html total=${totalHTML}`);

  try {
    execSync('git add adult-tv.html adult.html fx_fullxcinema_movies.js', { cwd: ROOT, stdio: 'pipe' });
    const msg = `Add ${chosen.length} best fullxcinema movies to adult section: ${chosen.map(f => f.title).join(', ')}`;
    execSync(`git commit -m "${msg}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git push', { cwd: ROOT, stdio: 'pipe' });
    log('Git commit & push OK');
  } catch (e) {
    log('Git error: ' + e.message);
  }

  log(`=== Done in ${Math.round((Date.now() - fs_start) / 1000)}s (${chosen.length} films) ===`);
}

main().catch(e => { console.error(e); process.exit(1); });