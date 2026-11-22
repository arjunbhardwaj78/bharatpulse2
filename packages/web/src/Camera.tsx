import { Camera as CamIcon, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Key } from './i18n';

/** A live camera inside the page. Phones and laptops both honour this; the plain file picker often opens the gallery instead. */
export function CameraModal({ t, onCapture, onClose, onFail }: { t: (k: Key) => string; onCapture: (f: File) => void; onClose: () => void; onFail: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream>();
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        stream.current?.getTracks().forEach((x) => x.stop());
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
        if (dead) return s.getTracks().forEach((x) => x.stop());
        stream.current = s;
        if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => undefined); }
      } catch { onFail(); }
    })();
    return () => { dead = true; stream.current?.getTracks().forEach((x) => x.stop()); };
  }, [facing]);

  function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    c.toBlob((b) => b && onCapture(new File([b], 'camera.jpg', { type: 'image/jpeg' })), 'image/jpeg', 0.88);
  }

  return (
    <div className="camera" role="dialog" aria-label="Camera">
      <video ref={video} playsInline muted />
      <div className="camctl">
        <button className="camx" onClick={onClose} aria-label={t('camCancel')}><X /></button>
        <button className="shutter" onClick={capture} aria-label={t('camCapture')}><CamIcon /></button>
        <button className="camx" onClick={() => setFacing(facing === 'environment' ? 'user' : 'environment')} aria-label={t('camSwitch')}><RefreshCw /></button>
      </div>
    </div>
  );
}
