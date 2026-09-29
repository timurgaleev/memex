/**
 * Is this buffer a binary file rather than text? A PNG or a PDF read as UTF-8
 * becomes a page of replacement characters that is chunked, embedded and
 * searched as if it were a note. Checked by the magic numbers of common binary
 * formats, then by a NUL byte in the first 8 KB (text never carries one).
 */
const MAGIC: number[][] = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x25, 0x50, 0x44, 0x46], // PDF
  [0x50, 0x4b, 0x03, 0x04], // ZIP (docx, xlsx, jar)
  [0x1f, 0x8b], // gzip
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O
  [0x52, 0x49, 0x46, 0x46], // RIFF (wav, webp, avi)
];

export function looksBinary(buf: Uint8Array): boolean {
  if (MAGIC.some((sig) => sig.length <= buf.length && sig.every((b, i) => buf[i] === b))) return true;
  return buf.subarray(0, 8192).includes(0);
}
