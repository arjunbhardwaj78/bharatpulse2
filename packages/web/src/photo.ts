export const asBase64 = (b: Blob): Promise<string> => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(b); });

/** Sends the original (so the capture time survives) unless it is big, then a smaller JPEG. */
export async function photoToBase64(file: Blob, max = 1280, keepBelow = 3_500_000): Promise<string> {
  if (file.size <= keepBelow) return asBase64(file);
  const bmp = await createImageBitmap(file);
  const s = max / Math.max(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8).split(',')[1];
}
