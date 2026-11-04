import { useEffect, useRef, useState } from 'react';

const TYPES = [
  { value: 'auto', label: 'Auto detect' },
  { value: 'direct', label: 'Direct video (MP4 / WebM / OGG)' },
  { value: 'hls', label: 'HLS (.m3u8)' },
  { value: 'dash', label: 'DASH (.mpd)' },
  { value: 'm3u', label: 'M3U channel playlist (.m3u)' },
];

const detectType = (u) => {
  const p = u.split('?')[0].toLowerCase();
  if (p.endsWith('.m3u8')) return 'hls';
  if (p.endsWith('.mpd')) return 'dash';
  if (p.endsWith('.m3u')) return 'm3u';
  return 'direct';
};

const relayUrl = (url, ref, kind) =>
  `/api/proxy?url=${encodeURIComponent(url)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}${kind ? `&kind=${kind}` : ''}`;

function Player({ src, type, onError }) {
  const videoRef = useRef(null);
  const errRef = useRef(onError);
  errRef.current = onError;

  useEffect(() => {
    const video = videoRef.current;
    let hls, dash, dead = false;

    (async () => {
      if (type === 'hls') {
        const Hls = (await import('hls.js')).default;
        if (dead) return;
        if (Hls.isSupported()) {
          hls = new Hls();
          hls.on(Hls.Events.ERROR, (_, d) => d.fatal && errRef.current(`HLS error: ${d.details}`));
          hls.loadSource(src);
          hls.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = src;
        } else {
          errRef.current('This browser cannot play HLS.');
        }
      } else if (type === 'dash') {
        const dashjs = (await import('dashjs')).default;
        if (dead) return;
        dash = dashjs.MediaPlayer().create();
        dash.on('error', (e) => errRef.current(`DASH error: ${e?.error?.message || 'playback failed'}`));
        dash.initialize(video, src, true);
      } else {
        video.src = src;
      }
      video.play().catch(() => {});
    })();

    return () => {
      dead = true;
      hls?.destroy();
      dash?.reset();
      video.removeAttribute('src');
      video.load();
    };
  }, [src, type]);

  return (
    <video
      ref={videoRef}
      controls
      playsInline
      onError={() => errRef.current('The browser could not play this file. Try another type or format.')}
    />
  );
}

export default function App() {
  const [url, setUrl] = useState('');
  const [type, setType] = useState('auto');
  const [referer, setReferer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [channels, setChannels] = useState([]);
  const [now, setNow] = useState(null); // { src, type, title }

  const start = (link, kind, title) => {
    setError('');
    setNow({ src: relayUrl(link, referer.trim(), kind === 'hls' || kind === 'dash' ? kind : ''), type: kind, title: title || link });
  };

  const submit = async (e) => {
    e.preventDefault();
    const link = url.trim();
    if (!link) return setError('Paste a video link first.');
    try { new URL(link); } catch { return setError('That is not a valid link. Include http:// or https://'); }

    setNow(null);
    setChannels([]);
    const kind = type === 'auto' ? detectType(link) : type;

    if (kind === 'm3u') {
      setBusy(true);
      try {
        const r = await fetch(`/api/playlist?url=${encodeURIComponent(link)}${referer.trim() ? `&ref=${encodeURIComponent(referer.trim())}` : ''}`);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Could not load playlist');
        if (data.isHls) start(link, 'hls');
        else if (!data.items.length) setError('No channels found in this playlist.');
        else setChannels(data.items);
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    } else {
      start(link, kind);
    }
  };

  return (
    <main className="page">
      <header>
        <h1>Stream Relay</h1>
        <p>Paste a link. The server fetches it and passes the stream to your player.</p>
      </header>

      <form onSubmit={submit} className="controls">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/stream/playlist.m3u8"
          aria-label="Video link"
        />
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Stream type">
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <button type="submit" disabled={busy}>{busy ? 'Loading…' : 'Play'}</button>
        <input
          className="ref"
          type="url"
          value={referer}
          onChange={(e) => setReferer(e.target.value)}
          placeholder="Referer (optional, for streams that check where requests come from)"
          aria-label="Referer"
        />
      </form>

      {error && <div className="error" role="alert">{error}</div>}

      <section className="stage">
        {now ? (
          <>
            <Player key={now.src + now.type} src={now.src} type={now.type} onError={setError} />
            <div className="title">{now.title}</div>
          </>
        ) : (
          <div className="empty">Your video will play here.</div>
        )}
      </section>

      {channels.length > 0 && (
        <section className="channels">
          <h2>{channels.length} channels</h2>
          <ul>
            {channels.map((c, i) => (
              <li key={i}>
                <button type="button" onClick={() => start(c.url, c.type, c.name)}>
                  {c.logo ? <img src={c.logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <span className="ph" />}
                  <span className="name">{c.name}</span>
                  {c.group && <span className="group">{c.group}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
