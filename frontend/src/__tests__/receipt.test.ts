import { parseDataUri, extForMime } from '../receipt';

describe('extForMime', () => {
  it('maps known image mimes to extensions', () => {
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('image/jpg')).toBe('jpg');
    expect(extForMime('image/png')).toBe('png');
  });

  it('is case-insensitive', () => {
    expect(extForMime('IMAGE/PNG')).toBe('png');
  });

  it('defaults unknown/empty mimes to jpg', () => {
    expect(extForMime('image/webp')).toBe('jpg');
    expect(extForMime('image/gif')).toBe('jpg');
    expect(extForMime('')).toBe('jpg');
  });
});

describe('parseDataUri', () => {
  it('splits a valid JPEG data URI', () => {
    expect(parseDataUri('data:image/jpeg;base64,/9j/4AAQSkZ')).toEqual({
      mime: 'image/jpeg',
      base64: '/9j/4AAQSkZ',
      ext: 'jpg',
    });
  });

  it('splits a valid PNG data URI and maps the extension', () => {
    expect(parseDataUri('data:image/png;base64,iVBORw0KGgo')).toEqual({
      mime: 'image/png',
      base64: 'iVBORw0KGgo',
      ext: 'png',
    });
  });

  it('falls back to jpg for an unknown mime', () => {
    expect(parseDataUri('data:image/webp;base64,UklGRg')).toEqual({
      mime: 'image/webp',
      base64: 'UklGRg',
      ext: 'jpg',
    });
  });

  it('returns null for non-data-URI inputs', () => {
    expect(parseDataUri('file:///var/mobile/receipt.jpg')).toBeNull();
    expect(parseDataUri('https://example.com/receipt.png')).toBeNull();
    expect(parseDataUri('image/jpeg;base64,abc')).toBeNull(); // no data: prefix
    expect(parseDataUri('data:image/jpeg,abc')).toBeNull(); // missing ;base64,
    expect(parseDataUri('data:image/jpeg;base64,')).toBeNull(); // empty payload
  });

  it('returns null for empty/whitespace/non-string input', () => {
    expect(parseDataUri('')).toBeNull();
    expect(parseDataUri('   ')).toBeNull();
    // parseDataUri takes `unknown`, so null/undefined are valid arguments.
    expect(parseDataUri(null)).toBeNull();
    expect(parseDataUri(undefined)).toBeNull();
  });
});
