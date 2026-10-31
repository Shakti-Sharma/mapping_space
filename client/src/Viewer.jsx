import { useEffect, useRef, useState } from 'react';
import { api, fmtBytes } from './api.js';

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(sec).padStart(2, '0')}`;
};

export default function Viewer({ provider, item, siblings, onNavigate, onClose, onError }) {
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    setInfo(null); setFailed(null);
    api.preview(provider, item.id).then(setInfo).catch((e) => setFailed(e.message));
  }, [provider, item.id]);

  useEffect(() => {
    const idx = siblings.findIndex((s) => s.id === item.id);
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowRight' && idx < siblings.length - 1) onNavigate(siblings[idx + 1]);
      if (e.key === 'ArrowLeft' && idx > 0) onNavigate(siblings[idx - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item.id, siblings, onClose, onNavigate]);

  async function openWith(app, reveal) {
    setBusy(reveal ? 'reveal' : app || 'default');
    try { await api.open(provider, item.id, app, reveal); } catch (e) { onError(e.message); }
    setBusy(null);
  }

  const idx = siblings.findIndex((s) => s.id === item.id);
  return (
    <div className="viewer" onClick={onClose}>
      <div className="viewer-box" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <div className="viewer-title" title={item.id}>
            <b>{item.name}</b>
            <span>{fmtBytes(item.size)}{siblings.length > 1 && idx >= 0 ? ` · ${idx + 1} of ${siblings.length}` : ''}</span>
          </div>
          <div className="viewer-actions">
            {info?.apps?.length > 0 && <span className="lbl">Open with</span>}
            {info?.apps?.map((a) => (
              <button key={a} className="ghost sm" disabled={busy} onClick={() => openWith(a)}>{busy === a ? '…' : a}</button>
            ))}
            {info?.canOpenDefault && !info.apps?.length && info.kind !== 'text' && (
              <button className="ghost sm" disabled={busy} onClick={() => openWith(null)}>Open in default app</button>
            )}
            {info?.canReveal && <button className="ghost sm" disabled={busy} onClick={() => openWith(null, true)}>Show in Finder</button>}
            {info?.link && <a className="ghost sm" href={info.link} target="_blank" rel="noreferrer noopener">Open in Google Drive ↗</a>}
            {provider === 'gdrive' && info?.download && <a className="ghost sm" href={info.download}>Download</a>}
            <button className="ghost sm" onClick={onClose} title="Esc">✕</button>
          </div>
        </div>
        <div className="viewer-body">
          {idx > 0 && <button className="nav prev" onClick={() => onNavigate(siblings[idx - 1])} title="Previous (←)">‹</button>}
          {idx >= 0 && idx < siblings.length - 1 && <button className="nav next" onClick={() => onNavigate(siblings[idx + 1])} title="Next (→)">›</button>}
          {failed ? <Msg title="Can't preview" text={failed} />
            : !info ? <Msg title="Loading…" />
            : <Content key={item.id} info={{ ...info, provider }} />}
        </div>
      </div>
    </div>
  );
}

function Msg({ title, text, children }) {
  return <div className="viewer-msg"><h3>{title}</h3>{text && <p>{text}</p>}{children}</div>;
}

function Content({ info }) {
  if (info.demo) return <Msg title="Demo file" text="Demo items have no real content. Preview works on This Mac and Google Drive." />;
  if (info.blocked) return <Msg title={info.blockedKind === 'policy' ? '🔒 Blocked by security policy' : "macOS didn't allow access"} text={info.blocked} />;
  if (!info.kind) return <Msg title="No preview for this file type" text="Use Show in Finder or Open in Google Drive." />;
  if (info.mode === 'none') {
    return (
      <Msg title="Can't show this format in the app" text={info.reason || (info.kind === 'video' || info.kind === 'audio'
        ? 'Install ffmpeg once (brew install ffmpeg) and every video/audio format plays here. Or use Open with above.'
        : 'Use Open with above.')} />
    );
  }
  if (info.kind === 'image') return <ImageView info={info} />;
  if (info.kind === 'video' || info.kind === 'audio') return <MediaView info={info} />;
  if (info.kind === 'pdf' || info.kind === 'gdoc') return <iframe className="pdf" src={info.file} title={info.name} />;
  if (info.kind === 'text') return <TextView info={info} />;
  return null;
}

function ImageView({ info }) {
  const [src, setSrc] = useState(info.mode === 'convert' ? info.image : info.file);
  const [err, setErr] = useState(false);
  if (err) return <Msg title="Couldn't display this image" text="Try Open with above." />;
  return (
    <>
      <img className="img" src={src} alt={info.name} onError={() => (info.image && src !== info.image ? setSrc(info.image) : setErr(true))} />
      {src === info.image && <div className="viewer-note">Converted preview (original format isn't supported by the browser)</div>}
    </>
  );
}

// Plays natively when the browser can; otherwise (or on decode error) switches to the
// server's ffmpeg stream. Transcoded streams seek by restarting at a time offset.
function MediaView({ info }) {
  const isDrive = info.provider === 'gdrive' && info.kind === 'video';
  const [drivePlayer, setDrivePlayer] = useState(false);
  const [why, setWhy] = useState(null);
  if (isDrive && drivePlayer) {
    return (
      <div className="media video">
        <iframe className="drive-player" src={`https://drive.google.com/file/d/${encodeURIComponent(info.id)}/preview`}
          allow="autoplay; fullscreen" allowFullScreen title={info.name} referrerPolicy="no-referrer" />
        <div className="seek">
          <span>{why || 'Google Drive player — adapts quality to your internet speed.'}</span><i />
          <button className="ghost sm" onClick={() => { setDrivePlayer(false); setWhy(null); }}>Play original quality</button>
        </div>
      </div>
    );
  }
  return <LocalMediaView info={info} onSlow={isDrive ? (msg) => { setWhy(msg); setDrivePlayer(true); } : null}
    onDrivePlayer={isDrive ? () => setDrivePlayer(true) : null} />;
}

function LocalMediaView({ info, onSlow, onDrivePlayer }) {
  const [useStream, setUseStream] = useState(info.mode === 'transcode');
  const [mbps, setMbps] = useState(null);
  const stall = useRef({ since: 0, count: 0, total: 0 });
  const [offset, setOffset] = useState(0);
  const [duration, setDuration] = useState(null);
  const [now, setNow] = useState(0);
  const [err, setErr] = useState(null);
  const ref = useRef(null);
  const Tag = info.kind === 'audio' ? 'audio' : 'video';

  useEffect(() => {
    if (useStream && info.stream) fetch(`${info.stream}&probe=1`).then((r) => r.json()).then((j) => setDuration(j.duration)).catch(() => {});
  }, [useStream, info.stream]);

  const src = useStream ? `${info.stream}&t=${offset}` : info.file;
  // Drive videos bigger than the internet connection can carry keep pausing to buffer:
  // after repeated stalls switch to Google's own adaptive player.
  const onWaiting = () => { stall.current.since = performance.now(); };
  const onPlaying = () => {
    const st = stall.current;
    if (!st.since) return;
    const d = performance.now() - st.since; st.since = 0;
    if (d > 700) { st.count++; st.total += d; }
    if (onSlow && (st.count >= 2 || d > 5000)) onSlow(`Switched to Google Drive player: this video is ${mbps ? `${mbps} Mbps` : 'very high bitrate'} and kept buffering on your connection.`);
  };
  function onError() {
    if (!useStream && info.stream) setUseStream(true);
    else setErr(info.stream ? 'This file could not be decoded.' : 'Your browser can\'t play this format. Install ffmpeg (brew install ffmpeg) to play it here, or use Open with above.');
  }
  if (err) return <Msg title="Can't play this file" text={err} />;
  return (
    <div className={`media ${Tag}`}>
      <Tag ref={ref} key={src} src={src} controls autoPlay playsInline onError={onError}
        onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} onWaiting={onWaiting} onPlaying={onPlaying}
        onLoadedMetadata={(e) => { const dur = e.currentTarget.duration; if (dur && isFinite(dur)) setMbps(Math.round((info.size * 8) / dur / 1e6)); }} />
      {onDrivePlayer && !useStream && (
        <div className="seek">
          <span>{mbps ? `${mbps} Mbps original${mbps > 15 ? ' — may buffer on slower internet' : ''}` : 'Original quality from Drive'}</span><i />
          <button className="ghost sm" onClick={onDrivePlayer}>Use Google Drive player (smoother)</button>
        </div>
      )}
      {useStream && (
        <div className="seek">
          <span>{fmtTime(offset + now)}</span>
          {duration ? (
            <input type="range" min={0} max={Math.floor(duration)} step={1} value={Math.floor(offset + now)}
              onChange={(e) => { setOffset(Number(e.target.value)); setNow(0); }} />
          ) : <i />}
          <span>{duration ? fmtTime(duration) : ''}</span>
          <em>converted live with ffmpeg</em>
        </div>
      )}
    </div>
  );
}

function TextView({ info }) {
  const [text, setText] = useState(null);
  useEffect(() => {
    fetch(info.file).then(async (r) => (r.ok ? r.text() : Promise.reject(new Error((await r.json()).error)))).then(setText).catch((e) => setText(`⚠ ${e.message}`));
  }, [info.file]);
  return <pre className="text">{text ?? 'Loading…'}</pre>;
}
