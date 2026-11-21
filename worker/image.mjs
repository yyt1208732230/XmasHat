const MAX_IMAGE_SIZE = 3_000_000;
const MAX_FORM_SIZE = MAX_IMAGE_SIZE + 16_384;
const PNG_SIGNATURE = 0x89504e470d0a1a0an;

export async function readUpload(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().startsWith('multipart/form-data;') || !request.body) return null;
  // Bound the full multipart body even if Content-Length is absent.
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FORM_SIZE) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Response(new Blob(chunks), { headers: { 'Content-Type': type } }).formData().catch(() => null);
}

function fourCC(view, offset) {
  return String.fromCharCode(...new Uint8Array(view.buffer, offset, 4));
}

function isStaticPNG(view) {
  if (view.byteLength < 45 || view.getBigUint64(0) !== PNG_SIGNATURE || view.getUint32(8) !== 13
    || fourCC(view, 12) !== 'IHDR') return false;
  let hasImage = false;
  for (let offset = 8; offset + 12 <= view.byteLength;) {
    const length = view.getUint32(offset);
    const chunk = fourCC(view, offset + 4);
    offset += 12 + length;
    if (offset > view.byteLength || ['acTL', 'fcTL', 'fdAT'].includes(chunk)) return false;
    if (chunk === 'IDAT' && length) hasImage = true;
    if (chunk === 'IEND') return hasImage && length === 0 && offset === view.byteLength;
  }
  return false;
}

function isStaticWebP(view) {
  if (view.byteLength < 20 || fourCC(view, 0) !== 'RIFF' || fourCC(view, 8) !== 'WEBP'
    || view.getUint32(4, true) + 8 !== view.byteLength) return false;
  let imageCount = 0;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunk = fourCC(view, offset);
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    offset = data + length + (length % 2);
    if (offset > view.byteLength || chunk === 'ANIM' || chunk === 'ANMF') return false;
    if (chunk === 'VP8X' && (length !== 10 || (view.getUint8(data) & 2))) return false;
    if ((chunk === 'VP8 ' && length >= 10) || (chunk === 'VP8L' && length >= 5)) imageCount++;
  }
  return offset === view.byteLength && imageCount === 1;
}

function isStaticJPEG(view) {
  if (view.byteLength < 12 || view.getUint16(0) !== 0xffd8 || view.getUint16(view.byteLength - 2) !== 0xffd9) return false;
  let frame = false;
  for (let offset = 2; offset + 4 < view.byteLength;) {
    if (view.getUint8(offset++) !== 0xff) return false;
    while (offset < view.byteLength && view.getUint8(offset) === 0xff) offset++;
    if (offset + 3 > view.byteLength) return false;
    const marker = view.getUint8(offset++);
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > view.byteLength - 2) return false;
    if (marker === 0xe2 && length >= 6 && fourCC(view, offset + 2) === 'MPF\0') return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) frame = true;
    if (marker === 0xda) return frame;
    offset += length;
  }
  return false;
}

export async function verifyImage(file) {
  if (!(file instanceof File) || !file.size || file.size > MAX_IMAGE_SIZE) return null;
  const bytes = await file.arrayBuffer();
  const view = new DataView(bytes);
  if (isStaticPNG(view)) return { bytes, type: 'image/png' };
  if (isStaticWebP(view)) return { bytes, type: 'image/webp' };
  if (isStaticJPEG(view)) return { bytes, type: 'image/jpeg' };
  return null;
}
