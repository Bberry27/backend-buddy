// F19 browser check: every export control on the five report views produces a real download in
// the rendered offline artifact, under its own Content-Security-Policy, with no network request
// and no policy violation.
//
//   npm run build                         (so skill/assets/extensions/dist holds this bundle)
//   node --test packages/explorer/src/export-browser.test.mjs
//
// Playwright and pngjs come from the repository root's devDependencies; set EXPORT_BROWSER_MODULES
// to another node_modules directory to use those instead, and EXPORT_BROWSER_EXECUTABLE to a Chromium
// binary when Playwright's own build is not installed. The artifact is rendered from a
// synthetic, project-neutral schema by `skill/scripts/build_explorer.py`, the production renderer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** packages/explorer/src or skill/assets/extensions/src: find the skill folder from either. */
const skillRoot = [resolve(here, '../../../skill'), resolve(here, '../../..')].find(path => existsSync(join(path, 'scripts/build_explorer.py')));
const require = createRequire(import.meta.url);
const external = name => { try { return require(process.env.EXPORT_BROWSER_MODULES ? join(process.env.EXPORT_BROWSER_MODULES, name) : name); } catch { return undefined; } };
const playwright = external('playwright');
const pngjs = external('pngjs');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const bundle = skillRoot && join(skillRoot, 'assets/extensions/dist/extensions.js');
const skip = !playwright || !pngjs ? 'playwright and pngjs are not installed' : !skillRoot ? 'skill renderer not found' : !existsSync(bundle) ? 'run npm run build first' : false;

const ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";

const column = (name, more = {}) => ({ name, type: 'integer', pk: false, fk: '', nullable: 'False', index: false, unique: false, ...more });
const table = (id, domain, allColumns, more = {}) => ({ id, schema: id.split('.')[0], name: id.split('.')[1], className: id, domain, type: 'Transaction / operational', line: 1, allColumns, indexes: [], uniques: [], checks: [], ...more });
const schema = {
  project: { name: 'Synthetic Export Check', key: 'synthetic-export-check', dialect: 'postgresql' },
  source: { file: 'synthetic/export-check.json', commit: 'synthetic-0001', sha256: 'synthetic-sha', generated: '2026-02-03T04:05:06Z', basis: 'Synthetic schema for the F19 export browser check. No database was inspected.' },
  tables: [
    table('alpha.widgets', 'Alpha', [column('id', { pk: true }), column('gadget_id', { nullable: 'True' }), column('bin_id'), column('=cmd_id'), column('label', { type: 'text', nullable: '' })], { rowCount: 0 }),
    table('alpha.gadgets', 'Alpha', [column('id', { pk: true }), column('part_id')]),
    table('beta.parts', 'Beta', [column('id', { pk: true }), column('widget_id')], { rowCount: 40, indexes: [{ name: 'ix_parts_widget', columns: ['widget_id'] }] }),
    table('beta.notes', 'Beta', [column('body', { type: 'text' }), column('part_id')], { rowCount: 5 }),
    table('gamma.loops', 'Gamma', [column('id', { pk: true }), column('parent_id', { nullable: 'True' })], { rowCount: 7, indexes: [{ name: 'ix_loops_parent', columns: ['parent_id'] }] }),
  ],
  links: [
    { source: 'alpha.widgets', column: 'gadget_id', target: 'alpha.gadgets', targetColumn: 'id', kind: 'declared FK' },
    { source: 'alpha.widgets', column: 'bin_id', target: 'alpha.bins', targetColumn: 'id', kind: 'inferred by naming' },
    { source: 'alpha.gadgets', column: 'part_id', target: 'beta.parts', targetColumn: 'id', kind: 'declared FK' },
    { source: 'beta.parts', column: 'widget_id', target: 'alpha.widgets', targetColumn: 'id', kind: 'declared FK' },
    { source: 'beta.notes', column: 'part_id', target: 'beta.parts', targetColumn: 'id', kind: 'declared FK' },
    { source: 'gamma.loops', column: 'parent_id', target: 'gamma.loops', targetColumn: 'id', kind: 'declared FK' },
  ],
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('F19 export controls download reports under the offline artifact CSP', { skip, timeout: 240_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'bb-f19-'));
  const schemaPath = join(work, 'schema.json'), artifact = join(work, 'artifact.html');
  writeFileSync(schemaPath, JSON.stringify(schema));
  const rendered = spawnSync(python, [join(skillRoot, 'scripts/build_explorer.py'), '--schema', schemaPath, '--output', artifact], { encoding: 'utf8' });
  assert.equal(rendered.status, 0, rendered.stderr);
  const html = readFileSync(artifact, 'utf8');
  assert.ok(html.includes(`content="${ARTIFACT_CSP}"`), 'artifact CSP is byte-for-byte the frozen policy');

  const browser = await playwright.chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    ...(process.env.EXPORT_BROWSER_EXECUTABLE ? { executablePath: process.env.EXPORT_BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { const url = request.url(); if (!/^(file|data|blob):/.test(url)) requests.push(url); });
    await page.addInitScript(() => {
      window.__violations = [];
      document.addEventListener('securitypolicyviolation', event => window.__violations.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    await page.goto(pathToFileURL(artifact).href);
    const graph = await page.evaluate(() => JSON.parse(document.getElementById('schema-data').textContent));

    let kept = 0;
    /** Click a control, wait for the download, return its name and bytes. */
    const download = async locator => {
      const pending = page.waitForEvent('download');
      await locator.click();
      const file = await pending;
      const result = { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
      // EXPORT_BROWSER_KEEP=<directory> keeps each download for visual review.
      if (process.env.EXPORT_BROWSER_KEEP) writeFileSync(join(process.env.EXPORT_BROWSER_KEEP, `${++kept}-${result.name}`), result.bytes);
      return result;
    };
    const assertPng = ({ name, bytes }, label) => {
      assert.match(name, /\.png$/, label);
      assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${label}: PNG signature`);
      const image = pngjs.PNG.sync.read(bytes);
      assert.ok(image.width >= 760 && image.height > 200, `${label}: ${image.width}x${image.height}`);
      const colours = new Set();
      for (let i = 0; i < image.data.length && colours.size < 4; i += 4 * 97) colours.add(image.data.readUInt32BE(i));
      assert.ok(colours.size > 2, `${label}: PNG is not a blank fill`);
    };
    const assertSvg = ({ name, bytes }, label, view) => {
      assert.match(name, /\.svg$/, label);
      const svg = bytes.toString('utf8');
      assert.ok(svg.startsWith('<?xml') && svg.includes('<svg xmlns="http://www.w3.org/2000/svg"'), `${label}: standalone SVG`);
      for (const fact of [`Project: ${graph.project.name} (${graph.project.key})`, `Snapshot generated: ${graph.source.generated}`, `Basis: ${graph.source.basis}`, `Backend Buddy export: ${view}`])
        assert.ok(svg.includes(fact), `${label}: provenance "${fact}"`);
      assert.ok(!/<script|href="https?:/i.test(svg), `${label}: no script, no remote reference`);
      return svg;
    };

    // PK / FK index (host view): CSV with provenance preamble and the formula guard.
    await page.locator('#tab-keys').click();
    const keys = await download(page.getByRole('button', { name: 'Export PK / FK index as CSV' }));
    assert.equal(keys.name, `${graph.project.key}-keys.csv`);
    const keysCsv = keys.bytes.toString('utf8');
    assert.ok(keysCsv.startsWith('﻿"# Backend Buddy export: PK / FK index"'));
    assert.ok(keysCsv.includes(`"# Snapshot generated: ${graph.source.generated}"`) && keysCsv.includes(`"# Basis: ${graph.source.basis}"`));
    assert.ok(keysCsv.includes('"\'=cmd_id"'), 'a formula-looking identifier is neutralised');
    assert.ok(!/(^|,)"=/m.test(keysCsv), 'no cell starts with a formula');
    assert.ok(keysCsv.includes('"Inferred reference"') && keysCsv.includes('"Declared FK"'), 'declared and inferred stay distinct');

    // Column Table: CSV and the highlighted HTML report.
    await page.locator('#tab-columns').click();
    const columnsCsv = (await download(page.getByRole('button', { name: 'Export Column Table as CSV' }))).bytes.toString('utf8');
    assert.ok(columnsCsv.includes(`"# Snapshot generated: ${graph.source.generated}"`));
    assert.ok(columnsCsv.includes('"Unindexed declared FK; Nullable declared FK"'));
    assert.ok(columnsCsv.includes('"No primary key recorded"') && columnsCsv.includes('"unknown"'));
    assert.ok(columnsCsv.includes('"\'=cmd_id"') && !/(^|,)"=/m.test(columnsCsv));
    const report = await download(page.getByRole('button', { name: 'Export Column Table issue report (HTML)' }));
    assert.equal(report.name, `${graph.project.key}-column-table-report.html`);
    const reportHtml = report.bytes.toString('utf8');
    assert.ok(!/<script/i.test(reportHtml));
    const reportPage = await browser.newPage();
    const reportRequests = [];
    reportPage.on('request', request => { if (!/^(data|about):/.test(request.url())) reportRequests.push(request.url()); });
    await reportPage.setContent(reportHtml);
    const highlight = await reportPage.evaluate(() => {
      const background = selector => getComputedStyle(document.querySelector(selector)).backgroundColor;
      const flagged = document.querySelector('table.columns tr.issue[data-issues~="unindexed-declared-fk"]');
      return { issue: background('table.columns tr.issue td'), clean: background('table.columns tr:not(.issue):not(.table-head) td'),
        flaggedText: flagged.textContent, tableIssue: document.querySelector('tr.table-head.issue[data-issues~="no-primary-key"]')?.textContent ?? '' };
    });
    assert.notEqual(highlight.issue, highlight.clean, 'issue rows are visibly highlighted');
    assert.match(highlight.flaggedText, /gadget_id[\s\S]*Issue: Unindexed declared FK[\s\S]*Issue: Nullable declared FK/, 'the issue is named in text, not colour alone');
    assert.match(highlight.tableIssue, /beta\.notes[\s\S]*Table issue: No primary key recorded/);
    assert.deepEqual(reportRequests, []);
    await reportPage.close();

    // Arc Diagram and Domains: SVG and PNG.
    await page.locator('#tab-arcs').click();
    const arcSvg = assertSvg(await download(page.getByRole('button', { name: 'Export Arc Diagram as SVG' })), 'arc SVG', 'Arc Diagram');
    assert.ok(arcSvg.includes('Cyclic FK') && arcSvg.includes('<path'), 'arc SVG carries its legend and arcs');
    assertPng(await download(page.getByRole('button', { name: 'Export Arc Diagram as PNG' })), 'arc PNG');
    await page.locator('#tab-domains').click();
    const domainsSvg = assertSvg(await download(page.getByRole('button', { name: 'Export Domains as SVG' })), 'domains SVG', 'Domains');
    assert.ok(domainsSvg.includes('Discovered communities are analytical suggestions'), 'C03 travels with the domains export');
    assertPng(await download(page.getByRole('button', { name: 'Export Domains as PNG' })), 'domains PNG');

    // Schema City: 3D frame as PNG, then the flat map as SVG and PNG.
    await page.locator('#tab-city').click();
    await page.locator('.schema-city canvas').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);
    assertPng(await download(page.getByRole('button', { name: 'Export Schema City as PNG' })), 'city 3D PNG');
    await page.getByRole('button', { name: 'Flat map' }).click();
    const citySvg = assertSvg(await download(page.getByRole('button', { name: 'Export Schema City as SVG' })), 'city flat SVG', 'Schema City, flat map');
    assert.ok(citySvg.includes('its row count is unknown, not zero'), 'unprofiled tables are labelled unknown');
    assertPng(await download(page.getByRole('button', { name: 'Export Schema City as PNG' })), 'city flat PNG');

    assert.deepEqual(await page.evaluate(() => window.__violations), [], 'no CSP violation');
    assert.deepEqual(requests, [], 'no network request');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
});
