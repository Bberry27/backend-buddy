import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Use an existing Playwright runtime; no dependency or host changes are needed.
// Set COLUMN_TABLE_PLAYWRIGHT_PATH to its package directory to enable this test.
test('Column Table browser interactions, profiling, export and responsive bounds', { skip: !process.env.COLUMN_TABLE_PLAYWRIGHT_PATH }, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.COLUMN_TABLE_PLAYWRIGHT_PATH!);
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
      contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import ColumnTable from './ColumnTable';
        const column = (name, type='integer', more={}) => ({name,type,pk:false,fk:'',nullable:'',index:false,unique:false,...more});
        const table = (id, allColumns, more={}) => ({id,className:id,domain:'test',type:'table',pk:'',allColumns,indexes:[],uniques:[],...more});
        const graph = {tables:[
          table('public.orders', [column('id','bigint',{pk:true}),column('customer_id'),column('description','text',{nullable:'True'}),column('amount','numeric(12,2)'),column('created_at','timestamp'),column('active','boolean'),column('metadata','jsonb'),column('payload','bytea'),column('tracking','uuid'),column('status',"enum('a','b')"),column('location','point'),column('very_long_column_name_that_must_wrap_without_overlapping_adjacent_tiles','text')],{primaryKey:['id'],indexes:[{columns:['id','customer_id']}]}),
          table('public.sampled', [column('state','text',{profiling:{nullFraction:.2,distinctCount:80,sampleSize:100,min:'A',max:'Z'}})], {rowCount:10000}),
          table('public.bulk', Array.from({length:2000},(_,i)=>column('field_'+i))),
          table('public.empty', [column('no_rows','integer',{profiling:{nullFraction:NaN}})], {rowCount:0})
        ],links:[{source:'public.orders',column:'customer_id',target:'public.customers',targetColumn:'id',kind:'declared FK'}]};
        window.testSelections=[];window.profileCalls=[];window.testGraph=graph;
        const root=createRoot(document.getElementById('root'));
        window.renderColumn=(mode='none')=>root.render(<ColumnTable graph={graph} onSelectTable={id=>window.testSelections.push(id)} live={mode==='none'?undefined:{profile:async request=>{
          window.profileCalls.push(request);
          if(mode==='error') throw new Error('Fixture profiling failure');
          const next={...graph,tables:graph.tables.map(t=>t.id==='public.orders'?{...t,rowCount:123,allColumns:t.allColumns.map(c=>({...c,profiling:{sampleSize:100,distinctCount:50,nullFraction:.1}}))}:t)};
          return {graph:next,sampled:true,limit:10000};
        }}}/>);
        window.renderColumn();
      `,
    },
    bundle: true, write: false, outfile: 'column-preview.js', format: 'iife', jsx: 'automatic',
  });
  const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  page.on('request', (request: { url: () => string }) => requests.push(request.url()));
  try {
    await page.setContent('<html><head></head><body style="margin:0"><div id="root" style="width:100%;height:100vh"></div></body></html>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: javascript });
    await page.locator('.ct-tile').first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Profile', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('.ct-tile').count(), 13, 'Only first two groups render their tiles initially');
    assert.equal(await page.locator('.ct-null-track').count(), 1, 'Unknown statistics must not fabricate null bars');
    assert.match(await page.locator('.ct-group').first().innerText(), /Rows unknown/);
    assert.match(await page.locator('.ct-group').nth(1).innerText(), /Distinct \/ sample: 80%/);
    assert.match(await page.locator('.ct-group').nth(1).innerText(), /Sample distinct \/ total rows: 0.8%/);
    await page.getByRole('checkbox', { name: 'Unindexed declared FKs' }).check();
    assert.equal(await page.locator('.ct-tile').count(), 1);
    assert.match(await page.locator('.ct-tile').innerText(), /customer_id/);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByRole('checkbox', { name: 'Nullable only' }).check();
    assert.equal(await page.locator('.ct-tile').count(), 1);
    assert.match(await page.locator('.ct-tile').innerText(), /description/);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByRole('checkbox', { name: 'json 1', exact: true }).check();
    assert.equal(await page.locator('.ct-tile').count(), 1);
    assert.match(await page.locator('.ct-tile').innerText(), /metadata/);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByRole('searchbox').fill('no_such_column');
    await page.getByText('No columns match these filters.').waitFor();
    await page.getByRole('searchbox').fill('bulk');
    await page.locator('.ct-tile').first().waitFor();
    assert.equal(await page.locator('.ct-tile').count(), 120);
    await page.getByRole('button', { name: 'Show 120 more (1,880 remaining)' }).click();
    assert.equal(await page.locator('.ct-tile').count(), 240);
    await page.getByRole('button', { name: 'Collapse all' }).click();
    assert.equal(await page.locator('.ct-tile').count(), 0);
    await page.getByRole('button', { name: 'Expand all' }).click();
    assert.equal(await page.locator('.ct-tile').count(), 120);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    assert.match(await page.locator('.ct-group').last().innerText(), /No statistics/, 'Invalid-only stats have an explicit unavailable state');
    await page.getByRole('button', { name: 'Inspect table public.orders', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).testSelections), ['public.orders']);
    await page.locator('.ct-group').nth(1).locator('.ct-tile').click();
    assert.equal(await page.getByRole('complementary', { name: 'Column inspector' }).isVisible(), true);
    assert.equal(await page.locator('.ct-inspector dd[title="A"]').count(), 1);

    for (const [width, height] of [[1920, 1080], [1366, 768], [390, 844], [320, 640]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `Document horizontal overflow at ${width}`);
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.ct-tile,.ct-inspector,.ct-toolbar')].every(element => element.scrollWidth <= element.clientWidth + 1)), true, `Content horizontal overflow at ${width}`);
      assert.equal(await page.evaluate(() => {
        const rects = [...document.querySelectorAll('.ct-tile')].map(element => element.getBoundingClientRect());
        return !rects.some((a, i) => rects.slice(i + 1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
      }), true, `Tile overlap at ${width}`);
      if (process.env.COLUMN_TABLE_SCREENSHOTS && (width === 1366 || width === 390)) await page.screenshot({ path: fileURLToPath(new URL(`column-qa-${width}.png`, import.meta.url)) });
    }
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.addStyleTag({ content: ':root{--bg:#f5f7f8;--panel:#ffffff;--raised:#e9eef0;--ink:#18272c;--muted:#536169;--line:#c9d1d5;--accent:#167b68}' });
    if (process.env.COLUMN_TABLE_SCREENSHOTS) await page.screenshot({ path: fileURLToPath(new URL('column-qa-light.png', import.meta.url)) });
    await page.evaluate(() => { document.getElementById('root')!.style.width = '390px'; });
    assert.equal(await page.evaluate(() => document.querySelector('.ct-body')!.scrollWidth <= 390), true, 'Narrow host uses container-responsive inspector');
    await page.evaluate(() => (window as any).renderColumn('error'));
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Fixture profiling failure' }).waitFor();
    await page.evaluate(() => (window as any).renderColumn('success'));
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByText('Sampled profile; limit 10,000 rows per table. Sample distinct counts are not total distinct estimates.').waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).profileCalls.at(-1)), { tables: ['public.orders', 'public.sampled', 'public.bulk', 'public.empty'], maxRowsPerTable: 10000 });
    assert.match(await page.locator('.ct-group').first().innerText(), /123 rows/);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export current schema snapshot (JSON)' }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const exported = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(exported.tables[0].rowCount, 123, 'Download uses the profiled graph');
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, [], 'View makes no network requests');
  } finally { await browser.close(); }
});
