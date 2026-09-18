#!/usr/bin/env node
/**
 * Nightly Adult Movie Updater
 * Searches allclassic.porn for new adult films matching target themes
 * Adds up to 10 new films per run to adult-tv.html and adult.html
 * 
 * Usage: node nightly_adult_updater.js
 * Schedule: Windows Task Scheduler / cron / GitHub Actions
 */

const fs = require('fs');
const https = require('https');
const { spawnSync } = require('child_process');
const { execSync } = require('child_process');

const FF_PROBE = 'C:\\Users\\ddude\\AppData\\Local\\Microsoft\\WinGet\\Packages\\yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-N-125365-g9a01c1cb6a-win64-gpl\\bin\\ffprobe.exe';

const TARGET_SEARCHES = [
  { query: 'first+time', max: 3 },
  { query: 'virgin', max: 3 },
  { query: 'teen', max: 2 },
  { query: 'schoolgirl', max: 2 },
  { query: 'barely+legal', max: 2 },
  { query: 'first+time+anal', max: 1 },
  { query: 'defloration', max: 1 },
  { query: 'innocent', max: 1 },
];

const ADULT_TV = 'C:\\Users\\ddude\\Documents\\Default Project\\trending4ever-repo\\adult-tv.html';
const ADULT_HTML = 'C:\\Users\\ddude\\Documents\\Default Project\\trending4ever-repo\\adult.html';
const LOG_FILE = 'C:\\Users\\ddude\\Documents\\Default Project\\trending4ever-repo\\nightly_update.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchAllClassic(query) {
  const url = `https://allclassic.porn/search/${encodeURIComponent(query)}/?order=video_viewed`;
  const { body } = await httpsGet(url);
  const ids = [...new Set(body.match(/videos\/(\d+)\//g) || [])].map(x => x.match(/\d+/)[0]);
  return ids.slice(0, 20);
}

async function getAllClassicMeta(id) {
  const url = `https://allclassic.porn/embed/${id}`;
  const { body } = await httpsGet(url);
  if (!body || !body.includes('video_title:')) return null;
  const titleMatch = body.match(/video_title:\s*'([^']+)'/);
  return titleMatch ? titleMatch[1] : null;
}

function getCurrentFilms() {
  const html = fs.readFileSync(ADULT_TV, 'utf8');
  const line = html.split('\n').find(l => l.includes('const FILMS=['));
  const firstB = line.indexOf('[');
  const lastSemicolon = line.lastIndexOf('];');
  const arrStr = line.slice(firstB, lastSemicolon + 1);
  let arr = JSON.parse(arrStr);
  if (arr.length === 1 && Array.isArray(arr[0])) arr = arr[0];
  return arr;
}

function filmExists(films, videoUrl) {
  return films.some(f => f.video === videoUrl);
}

function addFilms(newFilms) {
  for (const path of [ADULT_TV, ADULT_HTML]) {
    let html = fs.readFileSync(path, 'utf8');
    const lines = html.split('\n');
    const filmLineIdx = lines.findIndex(l => l.includes('const FILMS=['));
    if (filmLineIdx < 0) throw new Error('FILMS line not found in ' + path);
    
    const filmLine = lines[filmLineIdx];
    const firstB = filmLine.indexOf('[');
    const lastSemicolon = filmLine.lastIndexOf('];');
    const arrStr = filmLine.slice(firstB, lastSemicolon + 1);
    let arr = JSON.parse(arrStr);
    if (arr.length === 1 && Array.isArray(arr[0])) arr = arr[0];
    
    const nextId = arr.reduce((mx, x) => Math.max(mx, x.id), 0) + 1;
    const toAdd = newFilms.map(f => ({ ...f, id: f.id + nextId - f.id }));
    const final = arr.concat(toAdd);
    
    const newLine = 'const FILMS=' + JSON.stringify(final) + ';';
    lines[filmLineIdx] = newLine;
    fs.writeFileSync(path, lines.join('\n'), 'utf8');
    log(`  Updated ${path.split('\\').pop()}: +${toAdd.length} films (total ${final.length})`);
  }
}

async function main() {
  log('=== Nightly Adult Update Started ===');
  
  try {
    const existingFilms = getCurrentFilms();
    log(`Current films: ${existingFilms.length}`);
    
    const newFilms = [];
    const seenUrls = new Set(existingFilms.map(f => f.video));
    
    for (const { query, max } of TARGET_SEARCHES) {
      log(`Searching: ${query} (max ${max})`);
      const ids = await searchAllClassic(query);
      log(`  Found ${ids.length} candidates`);
      
      let added = 0;
      for (const id of ids) {
        if (added >= max) break;
        const embedUrl = `https://allclassic.porn/embed/${id}`;
        if (seenUrls.has(embedUrl)) continue;
        
        const title = await getAllClassicMeta(id);
        if (!title) { await sleep(100); continue; }
        
        // Filter: must be 1990+ or unknown year, adult theme
        const yearMatch = title.match(/\((\d{4})\)/);
        const year = yearMatch ? parseInt(yearMatch[1]) : 0;
        if (year && year < 1990 && year > 1900) { await sleep(100); continue; }
        
        const film = {
          id: 0,
          title: title.replace(/^\d+\s*/, ''),
          year: year || 1990,
          genreKey: 'adult',
          genreLabel: 'Adult',
          icon: '🔞',
          accent: '#b91c1c',
          rgb: '185,28,28',
          video: `https://allclassic.porn/embed/${id}`,
          cats: ['adult'],
          new: true,
          img: `https://allclassic.porn/contents/videos_screenshots/0/${id}/preview.jpg`,
          isEmbed: true
        };
        
        newFilms.push(film);
        seenUrls.add(embedUrl);
        added++;
        log(`  Added: ${film.title} (${embedUrl})`);
        await sleep(150);
      }
      
      if (newFilms.length >= 10) break;
      await sleep(500);
    }
    
    if (newFilms.length === 0) {
      log('No new films found');
      return;
    }
    
    // Limit to 10
    const toAdd = newFilms.slice(0, 10);
    log(`Adding ${toAdd.length} new films...`);
    addFilms(toAdd);
    
    // Git commit & push
    try {
      execSync('git add adult-tv.html adult.html', { cwd: 'C:\\Users\\ddude\\Documents\\Default Project\\trending4ever-repo', stdio: 'pipe' });
      const msg = `Auto-add ${toAdd.length} adult films: ${toAdd.map(f=>f.title).join(', ')}`;
      execSync(`git commit -m "${msg}"`, { cwd: 'C:\\Users\\ddude\\Documents\\Default Project\\trending4ever-repo', stdio: 'pipe' });
      execSync('git push', { cwd: 'C:\\Users\\ddude\\Documents\\Default Project\\trending4ever-repo', stdio: 'pipe' });
      log('Git commit & push successful');
    } catch (e) {
      log('Git error: ' + e.message);
    }
    
    log('=== Nightly Update Complete ===');
  } catch (e) {
    log('ERROR: ' + e.message);
    log(e.stack);
    process.exit(1);
  }
}

main();