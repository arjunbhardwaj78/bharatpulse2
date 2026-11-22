import { Download, Maximize2, Minus, Plus, X } from 'lucide-react';
import { useState } from 'react';

/** Shows a whole photo (never cropped). Click to open it full screen, where it can be zoomed and scrolled to check details. */
export function PhotoView({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  return (
    <>
      <button className="photoview" onClick={() => { setZoom(1); setOpen(true); }} aria-label={`${alt}: open full size`}>
        <img src={src} alt={alt} />
        <span className="hint"><Maximize2 size={14} /> Open full size</span>
      </button>
      {caption && <p className="muted small">{caption}</p>}
      {open && (
        <div className="lightbox" role="dialog" aria-label={alt}>
          <div className="lbbar">
            <button className="camx" onClick={() => setZoom(Math.max(1, zoom - 0.5))} aria-label="Zoom out"><Minus /></button>
            <span>{Math.round(zoom * 100)}%</span>
            <button className="camx" onClick={() => setZoom(Math.min(4, zoom + 0.5))} aria-label="Zoom in"><Plus /></button>
            <a className="camx" href={src} download="photo.jpg" aria-label="Download"><Download /></a>
            <button className="camx" onClick={() => setOpen(false)} aria-label="Close"><X /></button>
          </div>
          <div className="lbscroll"><img src={src} alt={alt} style={{ width: `${zoom * 100}%` }} /></div>
        </div>
      )}
    </>
  );
}
