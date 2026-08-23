/** Build one concrete category-detail path for every chart/legend navigation surface. */
export function categoryDetailPath(tripId: string, category: string): string {
  return `/trip/${encodeURIComponent(tripId)}/category/${encodeURIComponent(category)}`;
}

/** Expo Router usually decodes path parameters; this also accepts encoded deep-link values safely. */
export function decodeCategoryParam(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] ?? '' : value ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
