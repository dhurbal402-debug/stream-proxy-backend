# Stream Relay (Express + React + Node, no database)

Paste a video link, pick the type, press Play. The Node server fetches the video/manifest
and streams it back to the React player (HLS via hls.js, DASH via dash.js, direct via <video>).

## Run (development)
    npm run install:all
    npm run dev          # API :5000, site :5173

## Run (production, single server)
    npm run install:all
    npm run build
    npm start            # http://localhost:5000

## Notes
- Needs Node 18+.
- HLS/DASH manifests are rewritten so every playlist, key and segment also goes through the server.
- Private/internal IPs are blocked (SSRF protection). For local testing: ALLOW_PRIVATE=1 npm start
- Optional "Referer" field helps with streams that check where requests come from.
- DRM-protected streams (Widevine etc.) will not play.
- Only relay content you have the right to watch. Heavy streaming through one server uses its bandwidth.
