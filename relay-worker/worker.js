/**
 * IPTV HTTPS relay (Cloudflare Worker)
 * ---------------------------------------------------------------
 * Purpose: the Aurora IPTV page is served over HTTPS, so browsers block the
 * plain-HTTP HLS feeds (mixed content). This Worker fetches those HTTP feeds
 * server-side and re-serves them over HTTPS with CORS, rewriting every URI in
 * the HLS manifests (segments, encryption keys, sub-playlists) so playback
 * stays inside the relay.
 *
 * Usage:  GET /?u=<encoded absolute http(s) URL>
 *
 * Safety: only hosts on the allow-list (below, or ALLOWED_HOSTS var) can be
 * fetched, and private/loopback addresses are always rejected, so a public
 * deployment cannot be abused as an open proxy.
 */

// Hosts the relay may fetch. Add more here, or set ALLOWED_HOSTS in
// wrangler.toml as a comma-separated list. Use "*" to disable the allow-list
// (not recommended for a public deployment).
const DEFAULT_ALLOWED = [
  'vividmedia.xyz',
  '195.160.222.162',
  '185.150.189.223',
  '23.237.104.106',
  '23.239.31.26',
  '212.5.144.156',
  '190.197.41.183',
  '190.14.10.19',
  '41.205.93.154',
  '85.237.89.160',
  '198.58.104.90',
  'iptv.prosto.tv'
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Type,Content-Range,Accept-Ranges'
};

function json(body, status, extra) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...(extra || {}) }
  });
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '[::1]') return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
  }
  return false;
}

function allowedHosts(env) {
  const raw = (env && env.ALLOWED_HOSTS ? String(env.ALLOWED_HOSTS) : '').trim();
  if (raw === '*') return null; // null = allow anything (except private ranges)
  const extra = raw ? raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  return [...new Set([...DEFAULT_ALLOWED, ...extra])];
}

function hostAllowed(hostname, allowList) {
  if (!allowList) return true;
  const h = hostname.toLowerCase();
  return allowList.some(entry => h === entry || h.endsWith('.' + entry) || h.endsWith(entry) && entry.includes('/'));
}

function absolutize(ref, base) {
  try {
    return new URL(ref, base).toString();
  } catch (e) {
    return ref;
  }
}

/**
 * Cloudflare Workers refuse subrequests to bare IPv4 literals (edge error 1003),
 * but these IPTV panels are almost all IP-only. Mapping the literal to a DNS
 * name that resolves to the same address (nip.io) sidesteps that entirely.
 */
function proxyLiteral(hostname) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname + '.nip.io';
  return hostname;
}

function fetchableUrl(rawUrl) {
  const u = new URL(rawUrl);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) {
    u.hostname = proxyLiteral(u.hostname);
  }
  return u.toString();
}

/** Strip the nip.io wrapper so allow-list entries can be plain IPs. */
function bareHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h.replace(/\.nip\.io$/, '').replace(/\.sslip\.io$/, '');
}

/**
 * Rewrite an HLS manifest so every fetchable URI goes back through this Worker.
 * Handles segment lines, variant playlist lines, #EXT-X-KEY / #EXT-X-MAP /
 * #EXT-X-MEDIA / #EXT-X-PART URI="..." attributes, and protocol-relative URLs.
 */
function rewriteManifest(text, baseUrl, selfBase) {
  const wrap = u => selfBase + '?u=' + encodeURIComponent(u);
  return text
    .split(/\r?\n/)
    .map(line => {
      const t = line.trim();
      if (!t) return '';
      if (t.startsWith('#')) {
        // Only tag attribute URIs, never the whole tag (keeps #EXT-X-STREAM-INF intact).
        return line.replace(/URI="([^"]*)"/g, (m, u) => 'URI="' + wrap(absolutize(u, baseUrl)) + '"');
      }
      // Bare URI line: a media segment or a variant playlist.
      return wrap(absolutize(t, baseUrl));
    })
    .join('\n');
}

async function handle(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method not allowed' }, 405);
  }

  const self = new URL(request.url);
  const targetParam = self.searchParams.get('u') || self.searchParams.get('url');

  // Health check / usage help.
  if (!targetParam) {
    return json({
      ok: true,
      service: 'iptv-https-relay',
      usage: self.origin + '/?u=' + encodeURIComponent('http://example.com/live/index.m3u8'),
      allowedHosts: allowedHosts(env) || 'any (private ranges still blocked)'
    });
  }

  let target;
  try {
    target = new URL(targetParam);
  } catch (e) {
    return json({ error: 'malformed url' }, 400);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return json({ error: 'unsupported protocol' }, 400);
  }
  if (isPrivateHost(target.hostname)) {
    return json({ error: 'host not allowed' }, 403);
  }
  const allowList = allowedHosts(env);
  if (!hostAllowed(bareHost(target.hostname), allowList)) {
    return json({ error: 'host not allowed', host: target.hostname }, 403);
  }

  const upstreamHeaders = {
    'User-Agent': self.searchParams.get('ua') || request.headers.get('X-Relay-UA') || 'VLC/3.0.20 LibVLC/3.0.20',
    Accept: '*/*',
    Referer: target.origin + '/',
    Origin: target.origin
  };
  if (self.searchParams.get('noreferer')) delete upstreamHeaders.Referer;
  if (self.searchParams.get('noorigin')) delete upstreamHeaders.Origin;
  if (self.searchParams.get('accept')) upstreamHeaders.Accept = self.searchParams.get('accept');

  // Follow redirects manually so each hop's IP literal can be mapped to a
  // DNS name (panels routinely 302 to an IP:port).
  let current = target.toString();
  let upstream = null;
  let hops = 0;
  while (hops < 6) {
    try {
      upstream = await fetch(fetchableUrl(current), {
        method: 'GET',
        redirect: 'manual',
        headers: upstreamHeaders,
        cf: { cacheTtl: 0, cacheEverything: false }
      });
    } catch (e) {
      return json({ error: 'upstream fetch failed', detail: String(e && e.message || e), url: current }, 502);
    }
    const loc = upstream.headers.get('location');
    if (upstream.status >= 300 && upstream.status < 400 && loc) {
      current = absolutize(loc, current);
      hops++;
      continue;
    }
    break;
  }

  const finalUrl = current;
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

  // Diagnostics: /?u=<url>&debug=1 returns what the upstream actually said.
  if (self.searchParams.get('debug')) {
    const buf = await upstream.clone().arrayBuffer();
    const head = new TextDecoder().decode(buf.slice(0, 600));
    return json({
      target: target.toString(),
      finalUrl,
      status: upstream.status,
      contentType,
      bytes: buf.byteLength,
      server: upstream.headers.get('server'),
      cfRay: upstream.headers.get('cf-ray'),
      location: upstream.headers.get('location'),
      head: head.replace(/\s+/g, ' ').slice(0, 400)
    }, 200);
  }

  if (request.method === 'HEAD') {
    return new Response(null, { status: upstream.status, headers: { ...CORS, 'Content-Type': contentType, 'Cache-Control': 'no-store' } });
  }

  // Manifests are small: read, rewrite, return.
  const buffer = await upstream.arrayBuffer();
  const head = new TextDecoder().decode(buffer.slice(0, 16));
  const looksLikeHls = /mpegurl|m3u8/i.test(contentType) || head.startsWith('#EXTM3U');

  if (looksLikeHls && upstream.ok) {
    const text = new TextDecoder().decode(buffer);
    const selfBase = self.origin + self.pathname;
    const rewritten = rewriteManifest(text, finalUrl, selfBase);
    return new Response(rewritten, {
      status: upstream.status,
      headers: {
        ...CORS,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store, max-age=0',
        'X-Relay-Target': finalUrl
      }
    });
  }

  // Segments and keys: pass bytes through untouched.
  const passthrough = {
    ...CORS,
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=6',
    'X-Content-Type-Options': 'nosniff',
    'X-Relay-Target': finalUrl
  };
  const len = upstream.headers.get('content-length');
  if (len) passthrough['Content-Length'] = len;
  const range = upstream.headers.get('content-range');
  if (range) passthrough['Content-Range'] = range;
  const acceptRanges = upstream.headers.get('accept-ranges');
  if (acceptRanges) passthrough['Accept-Ranges'] = acceptRanges;

  return new Response(buffer, { status: upstream.status, headers: passthrough });
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      return json({ error: 'relay error', detail: String(e && e.message || e) }, 500);
    }
  }
};
