// Pure initials helper for avatars. Derives 1–2 uppercase letters from a single display-name
// string (User.name is one string, never split into first/last). Kept free of React/JSX so it
// unit-tests without a renderer — same convention as authNav.ts / displayNames.ts / permissions.ts.
//
// Rules (see CLAUDE.md Phase 19):
//   A) 2+ tokens (first[+middle]+last): first char of the FIRST token + first char of the LAST token
//      (middle names ignored). "Ram Mohan Sharma" -> "RS", "Ram Sharma" -> "RS".
//   B) single token, 2+ chars: first two chars. "Ram" -> "RA".
//   C) single token, 1 char: that char. "R" -> "R".
// Whitespace is trimmed and collapsed; a missing/empty name yields '' (the avatar then shows just
// the person icon, no initials).
export function initials(name?: string | null): string {
  const cleaned = (name ?? '').trim().replace(/\s+/g, ' ');
  if (cleaned === '') return '';
  const tokens = cleaned.split(' ').filter(Boolean);
  if (tokens.length >= 2) {
    return (tokens[0][0] + tokens[tokens.length - 1][0]).toUpperCase();
  }
  return tokens[0].slice(0, 2).toUpperCase();
}
