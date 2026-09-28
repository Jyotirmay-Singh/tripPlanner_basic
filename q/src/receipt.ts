// Receipt data-URI helpers. Pure (no native deps) so they can be unit-tested
// directly under src/__tests__/receipt.test.ts. Used by ReceiptViewer's
// save-to-gallery flow to turn a stored `data:image/...;base64,...` receipt
// into a file the OS media library can write to the camera roll.

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
};

/** Map an image mime type to a file extension. Unknown/empty -> 'jpg'. */
export function extForMime(mime: string): string {
  return MIME_EXT[(mime || '').toLowerCase()] ?? 'jpg';
}

export type ParsedDataUri = { mime: string; base64: string; ext: string };

// "data:<mime>;base64,<payload>". `s` flag so a stray newline in the payload
// still matches; we only accept base64-encoded data URIs.
const DATA_URI_RE = /^data:([^;,]+);base64,(.+)$/s;

/**
 * Split a base64 data URI into its parts. Returns null for anything that is not
 * a base64 data URI — including file:// / http(s) URIs, a missing ";base64,"
 * marker, empty/whitespace strings, and non-string input.
 */
export function parseDataUri(uri: unknown): ParsedDataUri | null {
  if (typeof uri !== 'string') return null;
  const match = DATA_URI_RE.exec(uri.trim());
  if (!match) return null;
  const [, mime, base64] = match;
  if (!base64) return null;
  return { mime, base64, ext: extForMime(mime) };
}
