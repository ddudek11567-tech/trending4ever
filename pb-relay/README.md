# Local relay for the Playboy (518382) stream

`iptv.html` points this channel at `http://127.0.0.1:8791/live.m3u8`.

## Why a local relay is needed

`vividmedia.xyz` answers `520` to every Cloudflare request, so the site-wide
Worker relay (`relay-worker/`) can never reach it on an HTTPS page.

A local relay sidesteps that: Chrome treats `http://127.0.0.1` as a secure
origin, so an HTTPS page is allowed to fetch from it with no mixed-content
error.

## Why the raw provider URL does not work in a player

Each playlist lists four 2-second segments, but:

* every segment URL expires after a few seconds, and
* the newest entry is usually not published yet.

VLC starts at the oldest entry, gets a `404`, and aborts with
`Program doesn't contain anymore ES` / `dead input` at about **14 seconds**.

The relay downloads each segment *before* listing it, serves the bytes from a
short-lived in-memory cache, and never emits a URL that is already gone. It also
keeps the provider's original ordering and media-sequence numbers so consecutive
refreshes overlap and playback has no gaps.

Verified: 90 s of continuous VLC playback, 62/62 requests `200`, zero misses.

## Run it

```
python pb_relay.py --port 8791
```

Then:

* VLC: `http://127.0.0.1:8791/live.m3u8`
* Browser: the Playboy row on `iptv.html`

`start-relay.vbs` launches it with no console window. The Startup shortcut
`Playboy relay.lnk` runs that script at login; the desktop shortcut
`Playboy (PC).lnk` opens VLC on the relay.

Health check: <http://127.0.0.1:8791/stats>

## Notes

* It only helps the PC it runs on (it needs that machine's network path to the
  provider).
* `KEEP_SEGMENTS` and `SEG_CACHE_SECONDS` at the top of the file are the two
  knobs worth touching.
