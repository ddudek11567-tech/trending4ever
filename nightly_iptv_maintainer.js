#!/usr/bin/env node
/**
 * Nightly IPTV Maintainer (runs daily at 01:00 ET via GitHub Actions)
 *
 * For iptv.html only:
 *  1. Checks EVERY channel URL across the whole site (iptv.html + stream links in all *.html pages).
 *  2. Broken channel -> search online (iptv-org public streams + leaked Xtream panel) for a
 *     working replacement; if found, make it the MAIN url. If not, REMOVE the channel.
 *  3. Discovers NEW premium English channels (Xtream panel "Premium Movie Channels")
 *     and adds up to 8 working ones per run.
 *
 * Usage:
 *   node nightly_iptv_maintainer.js          # full run: check, fix, write, git commit+push
 *   DRY_RUN=1 node nightly_iptv_maintainer.js # report only, no writes
 *
 * Requires Node 18+ (global fetch).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = process.cwd();
const IPTV_HTML = path.join(REPO, 'iptv.html');
const LOG_FILE = path.join(REPO, 'nightly_iptv.log');
const REPORT_FILE = path.join(REPO, 'nightly_iptv_report.json');
const DRY_RUN = process.env.DRY_RUN === '1';

const ORIGIN = 'https://ddudek11567-tech.github.io';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

// leaked Xtream panel (discovery + alternates)
const PANEL_BASE = 'http://vividmedia.xyz:80/player_api.php?username=judith11&password=judith11';
const PANEL_LIVE = id => `http://vividmedia.xyz:80/live/judith11/judith11/${id}.m3u8`;
const PANEL_PREMIUM_CAT = '231'; // "Premium Movie Channels"

const MAX_NEW_CHANNELS = 8;
const MAX_PREMIUM_PROBE = 25;
const MAX_CHAIN_TRIES = 2;
const FETCH_MS = 9000;
const POOL = 14;

const REPORT = {
  date: new Date().toISOString(),
  checked: 0, ok: 0, replaced: 0, removed: 0, added: [], broken: [], details: []
};

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function normName(n) {
  return String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function fetchText(url, timeoutMs = FETCH_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Origin': ORIGIN, 'Referer': ORIGIN + '/' },
      signal: ac.signal, redirect: 'follow'
    });
    if (res.status !== 200 && res.status !== 206) return { ok: false, status: res.status, aao: '', body: '' };
    const aao = (res.headers.get('access-control-allow-origin') || '').trim();
    const body = await res.text();
    return { ok: true, status: res.status, aao, body };
  } catch (e) {
    return { ok: false, status: 0, aao: '', body: '', err: e.name || e.message };
  } finally {
    clearTimeout(t);
  }
}

async function fetchBinary(url, timeoutMs = FETCH_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Origin': ORIGIN, 'Referer': ORIGIN + '/', 'Range': 'bytes=0-4095' },
      signal: ac.signal, redirect: 'follow'
    });
    const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    return { ok: res.ok, status: res.status, ct: (res.headers.get('content-type') || '').toLowerCase(), buf, aao: (res.headers.get('access-control-allow-origin') || '').trim() };
  } catch (e) {
    return { ok: false, status: 0, ct: '', buf: Buffer.alloc(0), aao: '', err: e.name || e.message };
  } finally {
    clearTimeout(t);
  }
}

function resolveUrl(base, ref) {
  try { return new URL(ref, base).href; } catch (_) { return ref; }
}

function parseSegments(playlist, base) {
  const segs = [];
  const re = /^#EXTINF:[^\n]*\n\s*([^\s][^\n]*)/gm;
  let m;
  while ((m = re.exec(playlist)) !== null) segs.push(resolveUrl(base, m[1].trim()));
  return segs;
}

function parseVariants(playlist, base) {
  const re = /^#EXT-X-STREAM-INF:[^\n]*\n\s*([^\s][^\n]*)/gm;
  const out = [];
  let m;
  while ((m = re.exec(playlist)) !== null) {
    const v = m[1].trim();
    if (v.startsWith('#') || v.length === 0) continue;
    out.push(resolveUrl(base, v));
  }
  return out;
}

/** Full chain check: master -> (variant) -> LIVE-EDGE segment. CORS must be open on master. */
async function chainCheck(url) {
  for (let attempt = 1; attempt <= MAX_CHAIN_TRIES; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, 3000));
    const t0 = Date.now();
    const first = await fetchText(url);
    if (!first.ok) {
      log(`  [chk] ${url} attempt ${attempt} FAIL st=${first.status}${first.err ? ' ' + first.err : ''} (${Date.now() - t0}ms)`);
      continue;
    }
    const body = first.body || '';
    const isPlaylist = body.includes('#EXTM3U') || body.includes('#EXTINF') || body.includes('#EXT-X-STREAM-INF');
    if (!isPlaylist) {
      log(`  [chk] ${url} attempt ${attempt} FAIL not-an-hls (len=${body.length})`);
      continue;
    }
    // CORS gate: hls.js fetches via XHR; must have AAO on master
    if (!first.aao) {
      log(`  [chk] ${url} attempt ${attempt} FAIL no-cors (AAO missing)`);
      continue;
    }

    let mediaUrl = url;
    if (body.includes('#EXT-X-STREAM-INF')) {
      const variants = parseVariants(body, url);
      if (!variants.length) continue;
      mediaUrl = variants[0];
    }
    const media = await fetchText(mediaUrl, FETCH_MS);
    if (!media.ok) {
      log(`  [chk] ${url} attempt ${attempt} FAIL variant st=${media.status}`);
      continue;
    }
    if (!(media.body || '').includes('#EXTINF')) continue;
    const segs = parseSegments(media.body, mediaUrl);
    if (!segs.length) continue;

    // LIVE-EDGE segment (last). First segment on short rotating playlists may already be stale.
    // Accept TS (0x47) AND fragmented-MP4 segments (don't require the sync byte).
    const seg = await fetchBinary(segs[segs.length - 1]);
    const segOk = seg.ok && (seg.status === 200 || seg.status === 206) && seg.buf.length >= 512;
    if (segOk) {
      return { ok: true, reason: `chain-ok(master ${first.status}, cv ${segs.length}, seg ${seg.status} ${seg.buf.length}B)`, ms: Date.now() - t0 };
    }
    log(`  [chk] ${url} attempt ${attempt} FAIL live-seg st=${seg.status} ${seg.err || ''} (${Date.now() - t0}ms)`);
  }
  return { ok: false, reason: 'chain-fail' };
}

/* ---------- iptv.html parsing ---------- */

function readIptv() {
  const html = fs.readFileSync(IPTV_HTML, 'utf8');
  const startMarker = 'const rawChannels = [';
  const si = html.indexOf(startMarker);
  if (si < 0) throw new Error('rawChannels marker not found');
  const ss = html.indexOf('[', si);
  const se = html.indexOf('];', ss);
  if (se < 0) throw new Error('rawChannels array end not found');
  const arrTxt = html.slice(ss, se + 1);
  let chans = eval('(' + arrTxt + ')');
  if (!Array.isArray(chans) || chans.length === 0) throw new Error('rawChannels parse empty');
  const epgStart = html.indexOf('const EPG_IDS=');
  let epg = {};
  if (epgStart >= 0) {
    const es = html.indexOf('{', epgStart);
    const ee = html.indexOf('};', es) + 1;
    epg = JSON.parse(html.slice(es, ee));
  }
  return { html, si, ss, se, chans, epg, epgStart, epgEdge: epgStart >= 0 ? html.indexOf('};', html.indexOf('{', epgStart)) + 1 : -1 };
}

function renderEntry(c) {
  const lines = [];
  lines.push('    {');
  lines.push(`            "name": ${JSON.stringify(c.name)},`);
  lines.push(`            "category": ${JSON.stringify(c.category || 'Entertainment')},`);
  lines.push(`            "icon": ${JSON.stringify(c.icon || '📺')},`);
  lines.push(`            "rating": ${JSON.stringify(c.rating || 'TV-14')},`);
  lines.push(`            "url": ${JSON.stringify(c.url)},`);
  const alts = (c.alternates || []).map(a => JSON.stringify(a));
  lines.push(`            "alternates": [${alts.join(', ')}]`);
  lines.push('    }');
  return lines.join('\n');
}

/* ---------- alternates / discovery ---------- */

async function iptvOrgAlternates(name) {
  const key = normName(name);
  if (!key || key.length < 4) return [];
  let streams;
  try {
    streams = await (await fetch('https://iptv-org.github.io/api/streams.json', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) })).json();
  } catch (_) { return []; }
  const out = new Map();
  for (const s of streams.slice(0, 40000)) {
    if (!s.url || typeof s.url !== 'string') continue;
    const cname = normName(s.channel) + normName(s.name || '');
    if (cname.length < 6) continue; // avoid garbage wildcard matches
    const u = String(s.url);
    const hit = cname.includes(key) || key.includes(cname);
    if (hit && /\.m3u8(?:\?|$|#)/.test(u) && !out.has(u)) out.set(u, true);
  }
  return [...out.keys()].slice(0, 10);
}

async function panelAlternates(name) {
  const key = normName(name);
  if (!key || key.length < 3) return [];
  try {
    const streams = await (await fetch(PANEL_BASE + '&action=get_live_streams', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })).json();
    if (!Array.isArray(streams)) return [];
    const scored = streams.map(s => {
      const n = normName(s.name);
      if (!n) return null;
      let score = 0;
      if (n === key) score = 4;                     // exact
      else if (n.includes(key)) score = 3;          // candidate contains search key
      else if (key.includes(n) && n.length >= 4) score = 1; // e.g. key="NHK World-Japan..." matches "NHK World"
      return score ? { s, score } : null;
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    return scored.slice(0, 5).map(x => PANEL_LIVE(x.s.stream_id));
  } catch (_) { return []; }
}

async function findWorkingAlternate(name) {
  const candidates = [...(await panelAlternates(name)), ...(await iptvOrgAlternates(name))];
  const seen = new Set();
  for (const u of candidates) {
    if (seen.has(u)) continue;
    seen.add(u);
    const r = await chainCheck(u);
    if (r.ok) return u;
  }
  return null;
}

const NON_ENGLISH = /espa|span|latino|\bes(\b|\.)|portug|itali|fran|turk|arab|hindi|tamil|brasil|mundo|mexico|argentina/i;
const ICON_MAP = {
  cinemax: '🎬', hbo: '🎭', starz: '⭐', showtime: '🌟', 'mgm+': '🦁', paramount: '🎥', epix: '🎞️', tmc: '🎟️', 'hbo family': '🎭'
};

async function discoverPremiumChannels(existingNames) {
  let streams;
  try {
    streams = await (await fetch(PANEL_BASE + '&action=get_live_streams', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })).json();
  } catch (e) { log('discovery: panel fetch failed ' + e.name); return []; }
  if (!Array.isArray(streams)) return [];
  const existing = new Set(existingNames.map(normName));
  const want = streams
    .filter(s => String(s.category_id) === PANEL_PREMIUM_CAT)
    .filter(s => s.name && !NON_ENGLISH.test(s.name))
    .filter(s => s.stream_id && !existing.has(normName(s.name)))
    .slice(0, MAX_PREMIUM_PROBE);
  const pool = [];
  for (const s of want) {
    pool.push({ s, url: PANEL_LIVE(s.stream_id) });
  }
  const results = await mapPool(pool, MAX_NEW_CHANNELS * 2, async ({ s, url }) => {
    const r = await chainCheck(url);
    return { s, url, ok: r.ok };
  });
  const added = [];
  for (const { s, url, ok } of results) {
    if (!ok || added.length >= MAX_NEW_CHANNELS) continue;
    const lname = e => (s.name || '').toLowerCase().includes(e);
    let icon = '🎬';
    for (const [k, v] of Object.entries(ICON_MAP)) if (lname(k)) { icon = v; break; }
    added.push({
      name: String(s.name || '').replace(/\*+$/g, '').trim(),
      category: 'Movies',
      icon,
      rating: 'TV-MA',
      url,
      alternates: []
    });
  }
  if (added.length) log(`discovery: added ${added.length} premium channels: ${added.map(a => a.name).join(', ')}`);
  return added;
}

/* ---------- whole-site stream link scan ---------- */

function collectSiteLinks() {
  const all = [];
  for (const f of fs.readdirSync(REPO)) {
    if (!f.endsWith('.html')) continue;
    const s = fs.readFileSync(path.join(REPO, f), 'utf8');
    const urls = s.match(/https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mpd)(?:\?[^\s"'<>\\]*)?/g) || [];
    for (const u of urls) all.push({ page: f, url: u.replace(/\\u003d/g, '=').replace(/\s+$/, '') });
  }
  return all;
}

/** Known dead main links -> confirmed working live link. Applied to every html page. */
const FIX_LINK = {
  'http://190.11.225.124:5000/live/playboy_hd/playlist.m3u8': 'http://vividmedia.xyz:80/live/judith11/judith11/518382.m3u8'
};

function applyLinkFixes() {
  const changedPages = [];
  for (const [dead, live] of Object.entries(FIX_LINK)) {
    for (const f of fs.readdirSync(REPO)) {
      if (!f.endsWith('.html')) continue;
      const fp = path.join(REPO, f);
      let s = fs.readFileSync(fp, 'utf8');
      const n = s.split(dead).length - 1;
      if (!n) continue;
      s = s.split(dead).join(live);
      log(`page link fixed ${f}: ${n}x ${dead} -> ${live}`);
      REPORT.details.push({ action: 'page-link-fixed', page: f, old: dead, new: live, count: n });
      if (!DRY_RUN) fs.writeFileSync(fp, s, 'utf8');
      changedPages.push(f);
    }
  }
  return [...new Set(changedPages)];
}

/** channels.html: check every channel link; swap in a working alternate or drop the entry. */
async function fixChannelsPage() {
  const f = path.join(REPO, 'channels.html');
  if (!fs.existsSync(f)) return { kept: 0, replaced: 0, removed: 0 };
  const src = fs.readFileSync(f, 'utf8');
  const liRe = /<li><a href="([^"]+)"[^>]*>([^<]+)<\/a><\/li>/g;
  const matches = [...src.matchAll(liRe)];
  if (!matches.length) return { kept: 0, replaced: 0, removed: 0 };
  const out = await mapPool(matches, POOL, async (m, i) => {
    const name = m[2].trim();
    const url = m[1];
    const r = await chainCheck(url);
    if (r.ok) {
      REPORT.details.push({ action: 'ch-keep', name, url });
      return { m, i, kind: 'keep', text: m[0] };
    }
    log(`channels.html BROKEN: ${name} -> ${url}`);
    const alt = await findWorkingAlternate(name);
    if (alt) {
      log(`  channels.html REPLACED: ${name} -> ${alt}`);
      REPORT.details.push({ action: 'ch-replaced', name, old: url, new: alt });
      return { m, i, kind: 'replaced', text: `<li><a href="${alt}" target="_blank">${name}</a></li>` };
    }
    REPORT.details.push({ action: 'ch-removed', name, url });
    return { m, i, kind: 'removed', text: null };
  });
  const kept = out.filter(o => o.kind === 'keep').length;
  const replaced = out.filter(o => o.kind === 'replaced').length;
  const removed = out.filter(o => o.kind === 'removed').length;
  if (!DRY_RUN && (replaced || removed)) {
    let buf = src;
    out.sort((a, b) => b.i - a.i); // edit back-to-front so offsets stay valid
    for (const o of out) {
      if (o.kind === 'removed') buf = buf.slice(0, o.m.index) + buf.slice(o.m.index + o.m[0].length);
      else if (o.kind === 'replaced') buf = buf.slice(0, o.m.index) + o.text + buf.slice(o.m.index + o.m[0].length);
    }
    fs.writeFileSync(f, buf, 'utf8');
    log(`wrote channels.html (kept ${kept}, replaced ${replaced}, removed ${removed})`);
  }
  return { kept, replaced, removed };
}

/* ---------- pool ---------- */

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------- main ---------- */

async function main() {
  log('=== Nightly IPTV Maintainer ===');
  log('DRY_RUN=' + DRY_RUN);

  const { html, si, ss, se, chans, epg, epgEdge } = readIptv();
  log(`loaded ${chans.length} channels`);
  REPORT.checked = chans.length;

  const results = await mapPool(chans, POOL, async (c) => {
    const r = await chainCheck(c.url);
    return { c, ok: r.ok, reason: r.reason };
  });

  const finalChans = [];
  for (const { c, ok, reason } of results) {
    if (ok) {
      REPORT.ok++;
      REPORT.details.push({ action: 'keep', name: c.name });
      finalChans.push(c);
      continue;
    }
    log(`BROKEN: ${c.name} -> ${c.url} (${reason})`);
    REPORT.broken.push({ name: c.name, url: c.url, reason });
    // try to find a working replacement online
    const alt = await findWorkingAlternate(c.name);
    if (alt) {
      const old = c.url;
      c.alternates = [...(c.alternates || []).map(a => a).filter(a => a !== old && a !== alt), old].slice(0, 3);
      c.url = alt;
      REPORT.replaced++;
      REPORT.details.push({ action: 'replaced', name: c.name, old, new: alt });
      log(`  REPLACED: ${c.name} -> ${alt}`);
      finalChans.push(c);
    } else {
      REPORT.removed++;
      REPORT.details.push({ action: 'removed', name: c.name, url: c.url });
      log(`  REMOVED: ${c.name}`);
    }
  }

  // NEW premium English channels
  const added = await discoverPremiumChannels(finalChans.map(c => c.name));
  for (const a of added) {
    finalChans.push(a);
    REPORT.added.push({ name: a.name, url: a.url });
  }

  // sort + stable helpers
  finalChans.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));

  // EPG map maintenance
  const newEpg = {};
  for (const c of finalChans) newEpg[c.name] = epg[c.name] || null;

  // whole-site scan (report only)
  const siteLinks = collectSiteLinks();
  const siteResults = await mapPool(siteLinks.slice(0, 30), POOL, async ({ page, url }) => {
    const r = await chainCheck(url);
    return { page, url, ok: r.ok, reason: r.reason };
  });
  for (const { page, url, ok } of siteResults) {
    REPORT.details.push({ action: ok ? 'site-ok' : 'site-BROKEN', page, url });
    if (!ok) log(`site BROKEN ${page} :: ${url}`);
  }

  // channels.html + known dead->live link fixes (whole site)
  const chFix = await fixChannelsPage();
  const linkFixedPages = applyLinkFixes();

  fs.writeFileSync(REPORT_FILE, JSON.stringify(REPORT, null, 1), 'utf8');
  log(`SUMMARY ok=${REPORT.ok} replaced=${REPORT.replaced} removed=${REPORT.removed} added=${added.length} chFix(rep/rem)=${chFix.replaced}/${chFix.removed} pageFixes=${linkFixedPages.length} total=${finalChans.length}`);

  const iptvChanged = REPORT.replaced || REPORT.removed || REPORT.added.length;
  const changed = iptvChanged || chFix.replaced || chFix.removed || linkFixedPages.length;
  if (!changed) {
    log('No changes; all links healthy. Done.');
    return;
  }
  if (DRY_RUN) {
    log('DRY_RUN: would have written iptv.html / channels.html and applied page fixes.');
    return;
  }

  // rebuild iptv.html only if the guide actually changed
  if (iptvChanged) {
    const block = 'const rawChannels = [\n' + finalChans.map(renderEntry).join(',\n') + '\n];';
    let out = html.slice(0, si) + block + html.slice(se + 2);
    const es = out.indexOf('{', out.indexOf('const EPG_IDS='));
    const ee = out.indexOf('};', es);
    out = out.slice(0, es) + JSON.stringify(newEpg) + out.slice(ee + 2);
    fs.writeFileSync(IPTV_HTML, out, 'utf8');
    log(`wrote iptv.html (${finalChans.length} channels)`);
  }

  // git commit & push
  try {
    const dirty = new Set(linkFixedPages);
    if (chFix.replaced || chFix.removed) dirty.add('channels.html');
    if (iptvChanged) dirty.add('iptv.html');
    const msg = `${REPORT.replaced ? 'replace ' + REPORT.replaced + '; ' : ''}${REPORT.removed ? 'remove ' + REPORT.removed + ' dead; ' : ''}${added.length ? 'add ' + added.length + ' premium; ' : ''}${chFix.replaced ? 'ch-replace ' + chFix.replaced + '; ' : ''}${chFix.removed ? 'ch-remove ' + chFix.removed + '; ' : ''}${linkFixedPages.length ? 'fixed ' + linkFixedPages.join(',') : ''}`.replace(/[; ]+$/, '');
    execSync(`git add ${[...dirty].join(' ')}`, { stdio: 'pipe' });
    execSync(`git commit -m "${msg}"`, { stdio: 'pipe' });
    execSync(`git push`, { stdio: 'pipe' });
    log('git commit+push OK: ' + msg);
  } catch (e) {
    if (/nothing to commit/i.test(e.message || '')) {
      log('nothing changed to commit');
    } else {
      log('GIT ERROR: ' + (e.message || e).split('\n')[0]);
    }
  }
  log('=== Complete ===');
}

main().catch(e => {
  log('FATAL: ' + (e && e.stack || e));
  process.exit(1);
});