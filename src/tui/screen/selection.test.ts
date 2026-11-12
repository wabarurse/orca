import { expect, test } from 'bun:test';
import { ConversationSelection, FrameSelection, linkAt, Pointer } from './selection';
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

const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
test('a frame selection covers any painted row, trims padding, and ends when its rows change', () => {
  const s = new FrameSelection();
  const frame = () => ['\x1b[1mTabs\x1b[0m  Agents 2', '› worker-fix   running', '  details 界 here   ', 'j/k move · esc close'];
  expect(s.mouse({ name: 'mousedown', x: 3, y: 2 })).toBe(false);
  // The press itself may move a marker: rows are first read at the paint after it.
  let rows = frame(); s.paint(rows, 24);
  expect(rows).toEqual(frame()); // a press alone highlights nothing
  s.mouse({ name: 'mousemove', x: 9, y: 3 });
  expect(s.mouse({ name: 'mouseup', x: 12, y: 3 })).toBe(true);
  rows = frame(); s.paint(rows, 24);
  expect(rows[0]).toBe(frame()[0]);
  expect(rows[1]).toBe('› \x1b[7mworker-fix   running\x1b[0m');
  expect(rows[2]).toBe('\x1b[7m  details 界\x1b[0m here   ');
  expect(s.text()).toBe('worker-fix   running\n  details 界');
  // A row outside the span may change (a clock in the header); one inside may not.
  rows = frame(); rows[0] = 'Tabs  Agents 3'; s.paint(rows, 24);
  expect(s.active).toBe(true);
  rows = frame(); rows[2] = '  details changed'; s.paint(rows, 24);
  expect(s.active).toBe(false); expect(rows[1]).toBe(frame()[1]); expect(s.text()).toBe('');
  // A click (release on the pressed cell) selects nothing.
  s.mouse({ name: 'mousedown', x: 3, y: 2 });
  expect(s.mouse({ name: 'mouseup', x: 3, y: 2 })).toBe(false);
  expect(s.active).toBe(false);
});

test('the link under a cell: its OSC 8 target through styling and wide characters, else a written-out web address', () => {
  const row = `\x1b[2mPR \x1b[0m界 ${link('https://github.com/o/r/pull/7', '\x1b[4m#7\x1b[0m')} see https://example.com/a(b). (${link('javascript:alert(1)', 'bad')}) ${link('mailto:a@b.co', 'mail')}`;
  const plain = Bun.stripANSI(row), at = (text: string) => Bun.stringWidth(plain.slice(0, plain.indexOf(text)));
  expect(linkAt(row, at('#7'))).toBe('https://github.com/o/r/pull/7');
  expect(linkAt(row, at('#7') + 1)).toBe('https://github.com/o/r/pull/7');
  expect(linkAt(row, at('#7') - 1)).toBeUndefined();
  expect(linkAt(row, at('界'))).toBeUndefined();
  expect(linkAt(row, at('example'))).toBe('https://example.com/a(b');
  expect(linkAt(row, at('. (bad'))).toBeUndefined(); // trailing punctuation is not the address
  expect(linkAt(row, at('bad'))).toBeUndefined(); // only web and mail targets are ever opened
  expect(linkAt(row, at('mail'))).toBe('mailto:a@b.co');
  expect(linkAt(row, 500)).toBeUndefined(); expect(linkAt('', 0)).toBeUndefined();
});

test('a click is a release on the pressed cell, and carries the link it began on', () => {
  const p = new Pointer(), rows = ['header', `go ${link('https://example.com', 'here')} now`];
  expect(p.track({ name: 'mousedown', x: 5, y: 2 }, rows)).toEqual({});
  expect(p.track({ name: 'mouseup', x: 5, y: 2 }, rows)).toEqual({ click: { name: 'mouseup', x: 5, y: 2 }, url: 'https://example.com' });
  p.track({ name: 'mousedown', x: 5, y: 2 }, rows);
  p.track({ name: 'mousemove', x: 6, y: 2 }, rows);
  expect(p.track({ name: 'mouseup', x: 6, y: 2 }, rows)).toEqual({}); // a drag over a link selects it
  p.track({ name: 'mousedown', x: 2, y: 1 }, rows);
  expect(p.track({ name: 'mouseup', x: 2, y: 1 }, rows)).toEqual({ click: { name: 'mouseup', x: 2, y: 1 } });
  expect(p.track({ name: 'mouseup', x: 2, y: 1 }, rows)).toEqual({}); // a release without a press
});
