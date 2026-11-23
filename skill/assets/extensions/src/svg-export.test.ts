import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildExportSvg, pngScale, wrapText } from './svg-export';

const frame = {
  title: 'Synthetic <Project>: Arc Diagram',
  lines: ['Snapshot generated: 2026-01-02T03:04:05Z', 'Basis: synthetic & "quoted"'],
  legend: [{ label: 'Child → parent', color: 'var-free-color' }, { label: 'Cyclic <FK>', color: 'other', dashed: true }],
  notes: ['C07 Declared and inferred evidence stay distinguishable: inferred is never declared.'],
  colors: { background: 'bg-value', ink: 'ink-value', muted: 'muted-value', line: 'line-value' },
};
const body = { markup: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><circle r="4"/></svg>', width: 400, height: 200 };

test('F19 exported SVG carries title, provenance, legend, notes and the diagram, all escaped', () => {
  const { svg, width, height } = buildExportSvg(frame, body);
  assert.ok(svg.startsWith('<?xml'));
  assert.ok(svg.includes('<title>Synthetic &lt;Project&gt;: Arc Diagram</title>'));
  assert.ok(svg.includes('Snapshot generated: 2026-01-02T03:04:05Z'));
  assert.ok(svg.includes('Basis: synthetic &amp; &quot;quoted&quot;'));
  assert.ok(svg.includes('Cyclic &lt;FK&gt;') && svg.includes('stroke-dasharray="4 3"'), 'dashed legend items stay dashed');
  assert.ok(svg.includes(body.markup), 'the diagram is embedded unchanged');
  assert.ok(svg.includes('inferred is never declared.'));
  assert.ok(svg.includes('<desc>') && svg.includes('fill="bg-value"'));
  assert.ok(width >= body.width && height > body.height);
  assert.ok(!svg.includes('<script') && !/href="https?:/.test(svg));
});

test('F19 long provenance lines wrap instead of running off the image', () => {
  const lines = wrapText('word '.repeat(200) + 'x'.repeat(500), 300);
  assert.ok(lines.length > 5);
  assert.ok(lines.every(line => line.length <= Math.floor(300 / 6.4)));
});

test('F19 PNG scale stays inside browser canvas limits', () => {
  assert.equal(pngScale(800, 600), 2);
  assert.ok(pngScale(9000, 600) * 9000 <= 8192);
  assert.ok(pngScale(6000, 6000) ** 2 * 36_000_000 <= 40_000_001);
});
