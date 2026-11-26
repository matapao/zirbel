// QR codes drawn in the page itself, by the qrcode package's browser build: an SVG picture in a data: URL, which the
// lobby's and the editor's img-src 'self' data: allow. A phone's camera opens the link one holds, so nobody types an
// address. Nothing here needs a secure page: a box serves these pages over plain http.
import QRCode from 'qrcode';

/** A picture of a QR code that holds text (a link), described by alt. */
export async function qrPicture(text: string, alt: string) {
  const svg = await QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  const picture = document.createElement('img');
  picture.className = 'qr';
  picture.alt = alt;
  picture.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
  return picture;
}
