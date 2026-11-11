/** Image decoding / resizing helpers for photo mode. */

export async function decodeImage(src: File | string): Promise<ImageBitmap> {
  let blob: Blob;
  let label: string;
  if (typeof src === 'string') {
    label = src.split('/').pop() || src;
    let res: Response;
    try {
      res = await fetch(src);
    } catch (err) {
      throw new Error(`Could not download image (${(err as Error).message || 'network error'})`);
    }
    if (!res.ok) throw new Error(`Could not download image (HTTP ${res.status})`);
    blob = await res.blob();
  } else {
    label = src.name;
    blob = src;
  }
  if (blob.size === 0) throw new Error(`"${label}" is empty`);
  if (blob.type && !blob.type.startsWith('image/')) {
    throw new Error(`"${label}" is not an image (${blob.type})`);
  }
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    const kind = blob.type ? ` (${blob.type})` : '';
    throw new Error(`Unsupported or corrupt image "${label}"${kind}. Try a JPEG, PNG or WebP.`);
  }
}

/** Draw `img` into a new canvas whose longest side is at most `maxSide`. */
export function drawScaled(img: CanvasImageSource & { width: number; height: number }, maxSide: number): HTMLCanvasElement {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  return c;
}

export function readPixels(c: HTMLCanvasElement): ImageData {
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('2D canvas unavailable');
  return g.getImageData(0, 0, c.width, c.height);
}
