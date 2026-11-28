import { createHash } from 'node:crypto';

/** SHA-256 in hex: how the host names a file's bytes. */
export const digest = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');

/** Whether bytes are of the media type they claim, by their first bytes. */
export function mediaMatches(media: string, bytes: Buffer) {
  switch (media) {
    case 'image/png':
      return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/jpeg':
      return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    case 'image/webp':
      return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    case 'video/mp4':
      return bytes.toString('ascii', 4, 8) === 'ftyp';
    case 'video/webm':
      return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
    case 'text/plain':
      return !bytes.includes(0) && !bytes.toString('utf8').includes('�');
    default:
      return false;
  }
}
