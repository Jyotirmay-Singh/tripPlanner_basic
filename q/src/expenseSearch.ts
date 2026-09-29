/** Match every whitespace-separated query word against the description, in any order. */
export function matchesExpenseDescription(description: unknown, query: string): boolean {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) return true;
  if (typeof description !== 'string') return false;

  const haystack = description.toLowerCase();
  return trimmedQuery.split(/\s+/).every((word) => haystack.includes(word));
}
