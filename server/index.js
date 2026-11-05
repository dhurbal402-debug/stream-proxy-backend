import express from 'express';
import cors from 'cors';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 6969;
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1'; // set to 1 only for local testing
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const app = express();
app.use(cors());

/* ---------- safety: block requests to private / internal networks (SSRF) ---------- */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  return true;
}

async function assertPublic(urlStr) {
  const u = new URL(urlStr);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https links are allowed');
  if (ALLOW_PRIVATE) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Private addresses are blocked');
    return u;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Private addresses are blocked');
  return u;
}

/* ---------- upstream fetch (follows redirects manually, re-checking each hop) ---------- */
async function fetchUpstream(url, { range, referer, signal }) {
  let current = url;
  for (let i = 0; i < 6; i++) {
    const u = await assertPublic(current);
    const headers = { 'User-Agent': UA, Accept: '*/*' };
    if (range) headers.Range = range;
    if (referer) {
      headers.Referer = referer;
      try { headers.Origin = new URL(referer).origin; } catch {}
    }
    const res = await fetch(u, { headers, redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), u).href;
      continue;
    }
    return { res, finalUrl: u.href };
  }
  throw new Error('Too many redirects');
}

/* ---------- URL helpers ---------- */
const proxyUrl = (abs, ref) =>
  `/api/proxy?url=${encodeURIComponent(abs)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`;

const encodeToken = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const decodeToken = (t) => JSON.parse(Buffer.from(t, 'base64url').toString());

/* ---------- manifest rewriting ---------- */
function rewriteM3u8(text, baseUrl, ref) {
  const px = (u) => (u.startsWith('data:') ? u : proxyUrl(new URL(u, baseUrl).href, ref));
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${px(u)}"`);
      return px(line.trim());
    })
    .join('\n');
}

// DASH segments are usually addressed relative to the MPD, so we point <BaseURL> at a
// path-style proxy (/api/dash/<token>/...) and every relative segment keeps working.
function rewriteMpd(text, baseUrl, ref) {
  const mk = (abs) => {
    const b = abs.endsWith('/') ? abs : new URL('.', abs).href;
    return `/api/dash/${encodeToken({ b, r: ref || '' })}/`;
  };
  const dir = new URL('.', baseUrl).href;
  if (/<BaseURL[^>]*>/i.test(text)) {
    return text.replace(/(<BaseURL[^>]*>)\s*([^<]+?)\s*(<\/BaseURL>)/gi, (_, open, val, close) =>
      `${open}${mk(new URL(val, dir).href)}${close}`
    );
  }
  return text.replace(/(<MPD\b[^>]*>)/i, `$1<BaseURL>${mk(dir)}</BaseURL>`);
}

/* ---------- core: fetch on the backend, hand over to the frontend ---------- */
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

async function relay(req, res, target, ref, kind) {
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  try {
    const { res: up, finalUrl } = await fetchUpstream(target, {
      range: req.headers.range,
      referer: ref,
      signal: ctrl.signal,
    });
    const ctype = up.headers.get('content-type') || '';
    const p = new URL(finalUrl).pathname;
    const isM3u8 = kind === 'hls' || /\.m3u8?$/i.test(p) || /mpegurl/i.test(ctype);
    const isMpd = kind === 'dash' || /\.mpd$/i.test(p) || /dash\+xml/i.test(ctype);

    if (up.ok && (isM3u8 || isMpd)) {
      const text = await up.text();
      res.set('Cache-Control', 'no-store');
      if (isM3u8) {
        res.type('application/vnd.apple.mpegurl').send(rewriteM3u8(text, finalUrl, ref));
      } else {
        res.type('application/dash+xml').send(rewriteMpd(text, finalUrl, ref));
      }
      return;
    }

    res.status(up.status);
    for (const h of PASS_HEADERS) {
      const v = up.headers.get(h);
      if (v) res.set(h, v);
    }
    if (!up.body) return res.end();
    const stream = Readable.fromWeb(up.body);
    stream.on('error', () => res.end());
    stream.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: err.message || 'Upstream fetch failed' });
    else res.end();
  }
}

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.get('/api/proxy', (req, res) => {
  const { url, ref, kind } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  relay(req, res, String(url), ref ? String(ref) : '', kind);
});

app.get('/api/dash/:token/*', (req, res) => {
  try {
    const { b, r } = decodeToken(req.params.token);
    const tail = req.originalUrl.slice(`/api/dash/${req.params.token}/`.length);
    relay(req, res, b + tail, r);
  } catch {
    res.status(400).json({ error: 'Bad token' });
  }
});

/* ---------- M3U channel playlists (IPTV-style) ---------- */
const guessType = (u) => (/\.m3u8?(\?|$)/i.test(u) ? 'hls' : /\.mpd(\?|$)/i.test(u) ? 'dash' : 'direct');

app.get('/api/playlist', async (req, res) => {
  const { url, ref } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const { res: up, finalUrl } = await fetchUpstream(String(url), { referer: ref ? String(ref) : '' });
    if (!up.ok) return res.status(up.status).json({ error: `Upstream returned ${up.status}` });
    const text = (await up.text()).slice(0, 5_000_000);

    // It is actually a single HLS stream, not a channel list
    if (/#EXT-X-(TARGETDURATION|STREAM-INF)/.test(text)) return res.json({ isHls: true, items: [] });

    const items = [];
    let meta = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF')) {
        meta = {
          name: line.slice(line.lastIndexOf(',') + 1).trim(),
          logo: (line.match(/tvg-logo="([^"]*)"/) || [])[1] || '',
          group: (line.match(/group-title="([^"]*)"/) || [])[1] || '',
        };
      } else if (!line.startsWith('#')) {
        let abs;
        try { abs = new URL(line, finalUrl).href; } catch { continue; }
        items.push({ name: meta?.name || abs, logo: meta?.logo || '', group: meta?.group || '', url: abs, type: guessType(abs) });
        meta = null;
        if (items.length >= 2000) break;
      }
    }
    res.json({ isHls: false, items });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ---------- serve the built React app in production ---------- */
const dist = path.join(__dirname, '../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => console.log(`Stream Relay API on http://localhost:${PORT}`));
