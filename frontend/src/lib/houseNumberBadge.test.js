import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHouseNumberBadgeDataUrl } from './houseNumberBadge.js';

describe('House number badge logo', () => {
  it('renders an SVG data URL containing the house number', () => {
    const url = buildHouseNumberBadgeDataUrl('12');
    assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'));
    const svg = decodeURIComponent(url.split(',')[1]);
    assert.match(svg, /<svg[^>]+width="48"/);
    assert.match(svg, />12<\/text>/);
  });

  it('returns null for empty house numbers so callers keep plain styling', () => {
    assert.equal(buildHouseNumberBadgeDataUrl(''), null);
    assert.equal(buildHouseNumberBadgeDataUrl(null), null);
    assert.equal(buildHouseNumberBadgeDataUrl('   '), null);
  });

  it('escapes XML-sensitive characters in the label', () => {
    const url = buildHouseNumberBadgeDataUrl('A&B<1>');
    const svg = decodeURIComponent(url.split(',')[1]);
    assert.ok(svg.includes('A&amp;B&lt;1&gt;'));
    assert.ok(!svg.includes('A&B'));
  });

  it('rejects non-hex colours so the SVG stays valid', () => {
    const url = buildHouseNumberBadgeDataUrl('7', 'red;fill=url(x)');
    const svg = decodeURIComponent(url.split(',')[1]);
    assert.ok(svg.includes('fill="#1d4ed8"'));
  });

  it('caches identical badges to avoid rebuilding style resources per feature', () => {
    assert.equal(buildHouseNumberBadgeDataUrl('45', '#059669'), buildHouseNumberBadgeDataUrl('45', '#059669'));
    assert.notEqual(buildHouseNumberBadgeDataUrl('45', '#059669'), buildHouseNumberBadgeDataUrl('46', '#059669'));
  });
});
