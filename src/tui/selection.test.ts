import { expect, test } from 'bun:test';
import { ConversationSelection } from './selection';
import type { StickyScreen } from './sticky';
const screen = (start = 0): StickyScreen => ({ rows: ['HEADER', 'a界éZ', 'second', 'FOOTER'], cols: 20, cursor: 3, col: 0, bodyTop: 1, bodyHeight: 2, start, maxStart: 2 });
const history = ['a界éZ', 'second', 'third', 'fourth'];
test('grapheme cells, backward drag, explicit text extraction, and offscreen ranges', () => {
  const s = new ConversationSelection();
  const f = screen();
  s.mouse({ name: 'mousedown', x: 4, y: 2 }, f, history);
  s.mouse({ name: 'mousemove', x: 3, y: 2 }, f, history);
  s.mouse({ name: 'mouseup', x: 2, y: 2 }, f, history);
  expect(s.text()).toBe('界é');
  s.paint(f, history);
  expect(f.rows).toEqual(['HEADER', 'a\x1b[7m界é\x1b[0mZ', 'second', 'FOOTER']);
  s.mouse({ name: 'mousemove', x: 7, y: 3 }, f, history);
  expect(s.text()).toBe('界é'); // release stops the drag
  const scrolled = screen(2);
  s.paint(scrolled, history);
  expect(scrolled.rows.join('')).not.toContain('\x1b[7m');
  s.paint(screen(), [...history, 'appended']);
  expect(s.text()).toBe('界é');
  s.paint(screen(), ['changed', ...history.slice(1)]);
  expect(s.active).toBe(false);
});
test('body-only hit testing; cross-row wraps copied as displayed; scroll during drag', () => {
  const s = new ConversationSelection();
  for (const y of [1, 4, 100]) {
    s.mouse({ name: 'mousedown', x: 1, y }, screen(), history);
    expect(s.active).toBe(false);
  }
  s.mouse({ name: 'mousedown', x: 1, y: 2 }, screen(), history);
  s.mouse({ name: 'mousemove', x: 3, y: 3 }, screen(1), history);
  s.mouse({ name: 'mouseup', x: 3, y: 3 }, screen(1), history);
  expect(s.text()).toBe('a界éZ\nsecond\nthi');
  const f = screen(1); s.paint(f, history);
  expect(f.rows[0]).toBe('HEADER'); expect(f.rows[3]).toBe('FOOTER');
  s.clear(); expect(s.text()).toBe('');
});

test('copy/highlight use the same sanitized clipped rows as the screen, never overflow into UI; links restore', () => {
  const s = new ConversationSelection(), f = screen();
  f.cols = 6;
  const link = '\x1b]8;;https://example.com\x1b\\abcdefghi\x1b]8;;\x1b\\';
  s.mouse({ name: 'mousedown', x: 1, y: 2 }, f, [link, 'next']);
  s.mouse({ name: 'mouseup', x: 6, y: 2 }, f, [link, 'next']);
  s.paint(f, [link, 'next']);
  expect(Bun.stripANSI(f.rows[1]!)).toBe(s.text());
  expect(Bun.stringWidth(s.text())).toBeLessThanOrEqual(6);
  expect(s.text()).not.toContain('https');
  expect(f.rows[3]).toBe('FOOTER');
  s.clear();
  const restored = screen(); restored.rows[1] = link;
  s.paint(restored, [link, 'next']);
  expect(restored.rows[1]).toBe(link);
});

test('completion is once per valid nonzero drag, never motion, click, invalid or canceled release', () => {
  const s = new ConversationSelection(), f = screen();
  const down = () => s.mouse({ name: 'mousedown', x: 1, y: 2 }, f, history);
  const up = (x = 5, y = 2) => s.mouse({ name: 'mouseup', x, y }, f, history);
  expect(up()).toBe(false);
  expect(down()).toBe(false);
  expect(up(1)).toBe(false);
  expect(s.text()).toBe('');
  down();
  expect(s.mouse({ name: 'mousemove', x: 4, y: 2 }, f, history)).toBe(false);
  expect(up()).toBe(true);
  expect(s.text()).toBe('a界éZ');
  expect(up()).toBe(false);
  for (const y of [1, 4, 100]) {
    down();
    s.mouse({ name: 'mousemove', x: 4, y: 2 }, f, history);
    expect(up(5, y)).toBe(false);
    expect(s.active).toBe(false);
  }
  down(); s.clear(); expect(up()).toBe(false);
  down(); s.paint(f, ['replacement', ...history.slice(1)]); expect(up()).toBe(false);
});
