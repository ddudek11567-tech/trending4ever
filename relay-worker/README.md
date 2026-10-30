# IPTV HTTPS relay (Cloudflare Worker)

The Aurora IPTV page is served over **HTTPS**, so browsers block the plain
**HTTP** HLS feeds (mixed content). This Worker fetches those feeds server-side
and re-serves them over HTTPS with CORS, rewriting every URI inside the HLS
manifests (segments, AES keys, sub-playlists) so playback stays inside the
relay.

It fixes the HTTP-only channels whose panels accept requests from outside
networks (e.g. `iptv.prosto.tv`, `23.237.104.106`, `41.205.93.154`).

Some hosts still cannot be relayed: `vividmedia.xyz` (Playboy) answers
Cloudflare with `error code: 520`, i.e. it refuses Cloudflare's egress IPs. For
those the page now shows a "host blocks the relay" notice with **Copy link** /
**Open** so the stream can be pasted into VLC instead of hanging.

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

Wrangler prints the public URL (this deployment):

```
https://nexus-aurora-relay.tvchannel.workers.dev
```

Optional: give it a stable custom domain in the Cloudflare dashboard
(Workers → nexus-aurora-relay → Settings → Domains & Routes), for example
`relay.trending4ever.com` (needs the domain's nameservers on Cloudflare).

## Test it

```powershell
$worker = 'https://nexus-aurora-relay.tvchannel.workers.dev'
$target = 'http://23.237.104.106:8080/USA_ANIMAL_PLANET/index.m3u8'

# health
curl.exe "$worker"

# manifest through the relay (should start with #EXTM3U and list relay URLs)
curl.exe "$worker/?u=$([uri]::EscapeDataString($target))"

# why a source failed (upstream status, final URL, first bytes)
curl.exe "$worker/?debug=1&u=$([uri]::EscapeDataString($target))"
```

## Wire it into the page

In `iptv.html`, set the constant near the source-list helpers:

```js
let RELAY_BASE = 'https://nexus-aurora-relay.tvchannel.workers.dev/';
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
- Cloudflare refuses subrequests to bare IPv4 literals (`error 1003`), and most
  IPTV panels are IP-only. The Worker therefore rewrites IP hosts to
  `<ip>.nip.io` (which resolves to the same address) and follows redirects
  manually so each hop is rewritten too.
- A host that blocks Cloudflare's egress (520/522) or filters datacenter IPs
  will not play through this relay; the page detects that and offers the raw
  link for VLC instead of retrying forever.
- Adult channels (e.g. Playboy) routed through Cloudflare may conflict with
  their acceptable-use policy. If the Worker gets suspended, the page falls
  back to the notice automatically (no crash, no hang).
- The relay forwards a VLC user-agent and `Referer`/`Origin` of the upstream
  host, because IPTV panels commonly reject requests without them.
