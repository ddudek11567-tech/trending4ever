# IPTV HTTPS relay (Cloudflare Worker)

The Aurora IPTV page is served over **HTTPS**, so browsers block the plain
**HTTP** HLS feeds (mixed content). This Worker fetches those feeds server-side
and re-serves them over HTTPS with CORS, rewriting every URI inside the HLS
manifests (segments, AES keys, sub-playlists) so playback stays inside the
relay.

It fixes channels like **Playboy** (`http://vividmedia.xyz:80/live/...`), whose
provider only offers plain HTTP plus a self-signed certificate, so no browser
can load it directly.

## What it does

```
GET https://<worker>/ ?u=<url-encoded upstream URL>
```

- `?u=` pointing at a `.m3u8` → fetches it, rewrites all URI lines /
  `URI="..."` attributes to point back at the Worker, returns the manifest.
- `?u=` pointing at a segment or key → streams the bytes through unchanged.
- No `?u=` → JSON health/usage response.

Safety: only hosts in the allow-list are fetched (`DEFAULT_ALLOWED` in
`worker.js`, or the `ALLOWED_HOSTS` var), and private/loopback addresses are
always rejected — a public deployment can't be used as an open proxy.

## Deploy (one time, ~2 minutes)

```powershell
cd "C:\Users\ddude\Documents\Default Project\trending4ever-repo\relay-worker"

# 1. Log in (opens a browser; approve the request)
npx wrangler login

# 2. Deploy
npx wrangler deploy
```

Wrangler prints the public URL, e.g.:

```
https://iptv-relay.<your-subdomain>.workers.dev
```

Optional: give it a stable custom domain in the Cloudflare dashboard
(Workers → iptv-relay → Settings → Domains & Routes), for example
`relay.trending4ever.com`.

## Test it

```powershell
$worker = 'https://iptv-relay.<your-subdomain>.workers.dev'
$target = 'http://vividmedia.xyz:80/live/judith11/judith11/518382.m3u8'

# health
curl.exe "$worker"

# manifest through the relay (should start with #EXTM3U and list relay URLs)
curl.exe "$worker/?u=$([uri]::EscapeDataString($target))"
```

## Wire it into the page

In `iptv.html`, set the constant near the source-list helpers:

```js
let RELAY_BASE = 'https://iptv-relay.<your-subdomain>.workers.dev/';
```

Every HTTP-only source is then routed through the relay automatically
(`viaRelay()`), while normal HTTPS sources are untouched. Leave it as `''` to
disable the relay and fall back to the amber "HTTP-only" notice.

## Cost / limits

Free plan: 100,000 requests/day. One hour of viewing is roughly
1,800 segment requests, so ~50 hours/day — plenty for personal use. Segments
are passed through without buffering to disk.

## Notes / risks

- Only needed for the ~70 HTTP-only channels; HTTPS channels never touch it.
- Adult channels (e.g. Playboy) routed through Cloudflare may conflict with
  their acceptable-use policy. If the Worker gets suspended, the page falls
  back to the "HTTP-only" notice automatically (no crash, no hang).
- The relay forwards a VLC user-agent and `Referer`/`Origin` of the upstream
  host, because IPTV panels commonly reject requests without them.
