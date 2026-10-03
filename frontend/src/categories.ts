import { CATEGORY_CATALOG, CATEGORIES, type CategoryName } from './categoryCatalog.generated';
import type { IconName } from './ui/Icon';
export { CATEGORY_CATALOG, CATEGORIES };
export type { CategoryName };
export const CATEGORY_SECTIONS = ['Travel & transport', 'Food & home', 'Personal & family', 'Shopping & leisure', 'Money & obligations', 'Work & business', 'Other'] as const;
export function isCategoryName(value: string): value is CategoryName {
  return CATEGORIES.some((name) => name === value);
}
export function categoryMetadata(name: string) {
  return CATEGORY_CATALOG.find((category) => category.name === name)
    ?? { name, section: '', icon: 'tag' as const, light: '#636D68', dark: '#A8B7AF', aliases: [] };
}
export function categoryIcon(name: string): IconName { return categoryMetadata(name).icon; }
export function categoryAccent(name: string, mode: 'light' | 'dark'): string { return categoryMetadata(name)[mode]; }
export function categoryOrder(name: string): number {
  const index = CATEGORIES.findIndex((item) => item === name);
  return index < 0 ? CATEGORIES.length : index;
}
export function categoryBadgeColor(name: string, mode: 'light' | 'dark', surface: string): string {
  const accent = categoryAccent(name, mode);
  const weight = mode === 'dark' ? 0.16 : 0.08;
  const rgb = [1, 3, 5].map((i) => Math.round(parseInt(accent.slice(i, i + 2), 16) * weight
    + parseInt(surface.slice(i, i + 2), 16) * (1 - weight)));
  return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
}
export function normalizeCategorySearch(value: string): string {
  return value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
export function searchCategories(query: string) {
  const normalized = normalizeCategorySearch(query);
  if (!normalized) return [...CATEGORY_CATALOG];
  const words = normalized.split(' ');
  return CATEGORY_CATALOG.map((category, order) => {
    const name = normalizeCategorySearch(category.name);
    const combined = name + ' ' + normalizeCategorySearch(category.aliases.join(' '));
    const matches = words.every((word) => combined.includes(word));
    const rank = name === normalized ? 0 : name.startsWith(normalized) ? 1
      : words.every((word) => name.includes(word)) ? 2 : 3;
    return { category, order, matches, rank };
  }).filter((row) => row.matches).sort((a, b) => a.rank - b.rank || a.order - b.order).map((row) => row.category);
}
export function categoryLayout(width: number, fontScale: number): 'list' | 2 | 3 {
  return fontScale >= 1.3 || width < 264 ? 'list' : width >= 552 ? 3 : 2;
}
