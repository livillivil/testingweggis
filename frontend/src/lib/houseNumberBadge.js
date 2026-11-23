// Metric house-number logo marker shared by the main map and the numbering registry view.

const BADGE_CACHE = new Map();
export const HOUSE_NUMBER_BADGE_SIZE = 44;

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fontSizeFor(text) {
  if (text.length <= 1) return 19;
  if (text.length === 2) return 17;
  if (text.length === 3) return 14;
  if (text.length === 4) return 12;
  if (text.length === 5) return 10;
  return 8;
}

/**
 * Builds a cached SVG data URL rendering a house-shaped badge with the number inside.
 * Returns null when no house number is available so callers can fall back to plain styling.
 */
export function buildHouseNumberBadgeDataUrl(houseNumber, color = '#1d4ed8') {
  const text = String(houseNumber ?? '').trim();
  if (!text) return null;

  const safeColor = HEX_COLOR.test(color) ? color : '#1d4ed8';
  const cacheKey = `${safeColor}::${text}`;
  const cached = BADGE_CACHE.get(cacheKey);
  if (cached) return cached;

  const fontSize = fontSizeFor(text);
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="44" viewBox="0 0 48 44">',
    `<path d="M24 2.5 45.5 19.5H39.5V41.5H8.5V19.5H2.5Z" fill="${safeColor}" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/>`,
    `<text x="24" y="35" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${escapeXml(text)}</text>`,
    '</svg>',
  ].join('');

  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  BADGE_CACHE.set(cacheKey, dataUrl);
  return dataUrl;
}
