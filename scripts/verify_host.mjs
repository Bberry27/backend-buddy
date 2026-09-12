#!/usr/bin/env node
// playwright and pngjs resolve from the node_modules above this file (root devDependencies once S02 pins them) or from NODE_PATH; a missing one exits 2 with instructions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
if (!args[0] || args.includes('--help')) {
  console.log('Usage: node verify_host.mjs <generated.html> [output-directory] [--skip-diff] [--views=map,city,...] [--widths=1920,1366,390] [--sample-fixture] [--local-living]');
  process.exit(args.includes('--help') ? 0 : 2);
}
const require = createRequire(import.meta.url);
const { chromium } = loadDependency('playwright');
const { PNG } = loadDependency('pngjs');
const input = resolve(args[0]);
const output = resolve(args[1] && !args[1].startsWith('--') ? args[1] : join(dirname(fileURLToPath(import.meta.url)), '../outputs/schema-map-qa'));
const requestedViews = args.find(value => value.startsWith('--views='))?.slice(8).split(',');
const widths = (args.find(value => value.startsWith('--widths='))?.slice(9) || '1920,1366,390').split(',').map(Number);
assert.ok(widths.every(width => Number.isFinite(width) && width >= 320), 'Viewport widths must be at least 320px');
await mkdir(output, { recursive: true });
const source = await readFile(input);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// Freeze the exact bytes so a parent's regeneration cannot mix versions within a run.
const captured = join(output, 'host-under-test.html');
await writeFile(captured, source);
const report = { input, captured, sha256: digest(source), startedAt: new Date().toISOString(), viewports: widths, schema: null, availableViews: [], skipped: [], checks: [], pageErrors: [], consoleErrors: [], externalRequests: [], screenshots: [] };
if(args.includes('--local-living')) {
  const {build}=await explorerEsbuild();
  const component=join(dirname(fileURLToPath(import.meta.url)),'../packages/explorer/src/LivingERD.tsx');
  const result=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import LivingERD from './LivingERD';const original=window.BackendBuddyViews;let local;window.BackendBuddyViews={...original,unmount(){local?.unmount();local=undefined;original.unmount();},mount(element,view,props){window.BackendBuddyViews.unmount();if(view==='living'){local=createRoot(element);local.render(<LivingERD {...props}/>);}else original.mount(element,view,props);}};`,resolveDir:dirname(component),loader:'tsx'},bundle:true,write:false,format:'iife',outfile:'living-local-qa.js',jsx:'automatic',logLevel:'silent'});
  const js=result.outputFiles.find(file=>file.path.endsWith('.js')).text,css=result.outputFiles.find(file=>file.path.endsWith('.css')).text;
  const original=source.toString('utf8');
  const marker=original.lastIndexOf('</body>');assert.ok(marker>=0,'Expected host closing body');
  await writeFile(captured,original.slice(0,marker)+`<style>${css}</style><script>${js.replaceAll('</script','<\\/script')}</script>`+original.slice(marker));
  report.localOverlay={component,componentSha256:digest(await readFile(component)),logicSha256:digest(await readFile(join(dirname(component),'living-logic.ts'))),note:'QA-only copy mounts local Living ERD source in the existing host. Original artifact is untouched.'};
}
const browser = await chromium.launch({ headless: true, channel: process.env.SCHEMA_QA_BROWSER_CHANNEL || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let context;
let page;
let current = { width: 0, view: 'startup' };
async function check(name, action) {
  const scope = { ...current };
  try {
    const evidence = await action();
    report.checks.push({ ...scope, name, passed: true, ...(evidence == null ? {} : { evidence }) });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.checks.push({ ...scope, name, passed: false, error: message });
    console.log(`FAIL ${scope.width}/${scope.view}: ${name}: ${message.slice(0, 220)}`);
    return false;
  }
}
async function screenshot(suffix = '') {
  const name = `${current.width}-${current.view}${suffix}.png`;
  await page.screenshot({ path: join(output, name), animations: 'disabled' });
  report.screenshots.push(name);
}
async function settle(ms = 220) { await page.waitForTimeout(ms); }
async function labelVisibility(selector, container) {
  return page.evaluate(({selector,container})=>{
    const clip=document.querySelector(container).getBoundingClientRect();
    const labels=[...document.querySelectorAll(selector)].map(node=>{const rect=node.getBoundingClientRect();return {label:node.textContent.trim(),rect:rect.toJSON(),visible:rect.width>0&&rect.height>0&&rect.right>clip.left&&rect.left<clip.right&&rect.bottom>clip.top&&rect.top<clip.bottom,contained:rect.left>=clip.left-1&&rect.right<=clip.right+1&&rect.top>=clip.top-1&&rect.bottom<=clip.bottom+1}});
    return {clip:clip.toJSON(),total:labels.length,visible:labels.filter(label=>label.visible).length,contained:labels.filter(label=>label.contained).length,clipped:labels.filter(label=>!label.contained)};
  },{selector,container});
}
async function closeInspector() { if (await page.locator('#side').isVisible()) { await page.locator('#closeSide').click(); await settle(); } }
async function boundsCheck(label = 'Document and content containment') {
  return check(label, async () => {
    const sizes = await page.evaluate(() => {
      const root = document.documentElement, content = document.querySelector('#content'), rect = content.getBoundingClientRect();
      const escaped = [...document.querySelectorAll('.top,.filters,.workspace,.side:not([hidden]),.content')].flatMap(node => {
        const b = node.getBoundingClientRect();
        return b.width > 0 && (b.left < -1 || b.right > innerWidth + 1) ? [{ selector: node.id || node.className, left: b.left, right: b.right }] : [];
      });
      return { viewport: {width:innerWidth,height:innerHeight}, document: {width:root.scrollWidth,height:root.scrollHeight}, content: rect.toJSON(), escaped };
    });
    assert.ok(sizes.document.width <= sizes.viewport.width + 1, JSON.stringify(sizes));
    assert.ok(sizes.document.height <= sizes.viewport.height + 1, JSON.stringify(sizes));
    assert.equal(sizes.escaped.length, 0, JSON.stringify(sizes));
    assert.ok(sizes.content.height > 120 && sizes.content.width > 100, JSON.stringify(sizes));
    return sizes;
  });
}
function pixels(buffer) {
  const png = PNG.sync.read(buffer), colors = new Set();
  let colorful = 0, grayGeometry = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const [r,g,b] = png.data.subarray(i,i+3), high = Math.max(r,g,b), low = Math.min(r,g,b);
    colors.add(`${r>>3},${g>>3},${b>>3}`);
    if (high-low > 35) colorful++;
    if (high-low < 25 && high > 85 && high < 245) grayGeometry++;
  }
  return {width:png.width,height:png.height,colorful,grayGeometry,colors:colors.size};
}
function changedPixels(a,b) {
  const before=PNG.sync.read(a), after=PNG.sync.read(b);
  if(before.width!==after.width||before.height!==after.height)return Infinity;
  let changed=0;
  for(let i=0;i<before.data.length;i+=4)if(Math.abs(before.data[i]-after.data[i])+Math.abs(before.data[i+1]-after.data[i+1])+Math.abs(before.data[i+2]-after.data[i+2])>30)changed++;
  return changed;
}
async function cityProjection() {
  return page.evaluate(()=>{
    const anchors=Object.fromEntries([...document.querySelectorAll('.schema-city-name[data-table-id]')].flatMap(node=>{
      const line=node.querySelector('line');
      return line?[[node.getAttribute('data-table-id'),{x:Number(line.getAttribute('x1')),y:Number(line.getAttribute('y1'))}]]:[];
    }));
    const matrix=document.querySelector('.schema-city-flat > g')?.transform.baseVal.consolidate()?.matrix;
    return {anchors,flatMatrix:matrix?{a:matrix.a,b:matrix.b,c:matrix.c,d:matrix.d,e:matrix.e,f:matrix.f}:null};
  });
}
function projectionMotion(before,after) {
  const shifts=Object.entries(before.anchors).flatMap(([id,p])=>{
    const q=after.anchors[id];return q?[{id,dx:q.x-p.x,dy:q.y-p.y,distance:Math.hypot(q.x-p.x,q.y-p.y)}]:[];
  }).sort((a,b)=>a.distance-b.distance);
  return {commonAnchors:shifts.length,movedAnchors:shifts.filter(shift=>shift.distance>3).length,medianDistance:shifts.length?shifts[Math.floor(shifts.length/2)].distance:0,shifts:shifts.slice(0,8)};
}
async function cityDragStart(mode,onLabel) {
  const point=await page.evaluate(({mode,onLabel})=>{
    const scene=document.querySelector('.schema-city-scene'),box=scene.getBoundingClientRect();
    const inside=(x,y)=>x>box.left+15&&x<box.right-15&&y>box.top+15&&y<box.bottom-15;
    if(onLabel) {
      for(const rect of scene.querySelectorAll('.schema-city-name > rect')) {
        const b=rect.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2;
        if(!inside(x,y)||b.width<45||b.height<10)continue;
        const node=rect.closest('.schema-city-name'),hit=document.elementFromPoint(x,y);
        if(hit?.closest('.schema-city-name')===node)return {x,y,label:node.getAttribute('data-table-id'),hit:hit.tagName,scene:box.toJSON(),labelWidth:b.width};
      }
    } else {
      // Use the actual hit target, so an SVG name overlay cannot silently intercept this case.
      for(const [rx,ry] of [[.15,.15],[.85,.15],[.5,.12],[.12,.5],[.88,.5],[.3,.3],[.7,.3],[.25,.75],[.75,.75]]) {
        const x=box.left+box.width*rx,y=box.top+box.height*ry,hit=document.elementFromPoint(x,y);
        if(!inside(x,y)||!hit||hit.closest('.schema-city-name,.schema-city-target'))continue;
        if(mode==='3d'?hit===scene.querySelector('canvas'):scene.querySelector('.schema-city-flat')?.contains(hit))return {x,y,hit:hit.tagName,scene:box.toJSON()};
      }
    }
    return null;
  },{mode,onLabel});
  assert.ok(point,`No hit-testable ${onLabel?'persistent label':'unlabelled scene'} drag origin in ${mode}`);
  return point;
}
async function zoomCity(mode) {
  await closeInspector();
  await page.getByRole('button',{name:mode==='3d'?'3D city':'Flat map',exact:true}).click();
  await page.getByRole('button',{name:'Fit city',exact:true}).click();await settle(300);
  const before=await cityProjection();
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();await settle(150);
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();await settle(350);
  const after=await cityProjection(),motion=projectionMotion(before,after);
  if(mode==='flat')assert.ok(after.flatMatrix?.a>before.flatMatrix?.a*1.1,`Zoom in did not enlarge flat geometry: ${JSON.stringify({before,after})}`);
  else assert.ok(motion.movedAnchors>0&&motion.medianDistance>3,`Zoom in did not move projected geometry: ${JSON.stringify(motion)}`);
  return motion;
}
async function cityDragCheck(mode,onLabel,button) {
  const zoomMotion=await zoomCity(mode);
  const point=await cityDragStart(mode,onLabel);
  const dx=Math.min(onLabel?48:80,point.scene.width*.18)*(point.x>point.scene.x+point.scene.width*.7?-1:1);
  const dy=onLabel?0:Math.min(40,point.scene.height*.12);
  const surface=page.locator(mode==='3d'?'.schema-city canvas':'.schema-city-flat');
  await page.mouse.move(point.x,point.y);await settle(150);
  const before=await cityProjection(),beforePixels=await surface.screenshot();
  const inspectorBefore=await page.locator('#detail h2').innerText();
  await page.evaluate(()=>{
    const side=document.querySelector('#side');
    window.__cityDragInspector={opened:!side.hidden};
    window.__cityDragObserver=new MutationObserver(()=>{if(!side.hidden)window.__cityDragInspector.opened=true;});
    window.__cityDragObserver.observe(side,{attributes:true,attributeFilter:['hidden']});
  });
  let inspectorOpened;
  try {
    await page.mouse.down({button});
    try { await page.mouse.move(point.x+dx,point.y+dy,{steps:12}); }
    finally { await page.mouse.up({button}); }
    await settle(300);
  } finally {
    inspectorOpened=await page.evaluate(()=>{window.__cityDragObserver.disconnect();const opened=window.__cityDragInspector.opened;delete window.__cityDragObserver;delete window.__cityDragInspector;return opened;});
  }
  const after=await cityProjection(),afterPixels=await surface.screenshot();
  const motion=projectionMotion(before,after),pixelChanges=changedPixels(beforePixels,afterPixels);
  const prefix=`${current.width}-city-drag-${mode}-${button}-${onLabel?'label':'scene'}`;
  for(const [phase,bytes] of [['before',beforePixels],['after',afterPixels]]) {
    const name=`${prefix}-${phase}.png`;await writeFile(join(output,name),bytes);report.screenshots.push(name);
  }
  const evidence={mode,button,origin:point,drag:{dx,dy},zoomMotion,pixelChanges,motion,inspectorOpened,beforeMatrix:before.flatMatrix,afterMatrix:after.flatMatrix};
  assert.equal(inspectorOpened,false,`Drag opened the inspector: ${JSON.stringify(evidence)}`);
  assert.equal(await page.locator('#side').isVisible(),false,'Inspector must stay closed after drag');
  assert.equal(await page.locator('#detail h2').innerText(),inspectorBefore,'Drag must not select a different table');
  assert.ok(Number.isFinite(pixelChanges)&&pixelChanges>300,`No rendered geometry motion: ${JSON.stringify(evidence)}`);
  assert.ok(motion.commonAnchors>0&&motion.movedAnchors>0&&motion.medianDistance>3,`Only overlay appearance changed, not projected building anchors: ${JSON.stringify(evidence)}`);
  if(mode==='flat') {
    const a=before.flatMatrix,b=after.flatMatrix;
    assert.ok(a&&b,'Flat geometry transform must be observable');
    for(const field of ['a','b','c','d'])assert.ok(Math.abs(a[field]-b[field])<1e-4,`Flat drag changed scale/rotation: ${JSON.stringify(evidence)}`);
    assert.ok(Math.hypot(a.e-b.e,a.f-b.f)>10,`Flat drag did not translate geometry: ${JSON.stringify(evidence)}`);
  }
  return evidence;
}
const viewSpecs = {
  map: { root: '#graph', item: '.graph-node', empty: 'No entities match the filters' },
  entities: { root: '.data-scroll', item: 'tr[data-row]', empty: 'No matching results' },
  keys: { root: '.data-scroll', item: 'tr[data-row]', empty: 'No matching results' },
  review: { root: '.data-scroll', item: 'tr[data-row]', empty: 'No matching results' },
  fanout: { root: '.fanout-view', item: '.fanout-node', empty: 'No tables available.' },
  columns: { root: '.ct-root', item: '.ct-tile', empty: /No (columns|tables)/i },
  city: { root: '.schema-city', item: 'canvas,.schema-city-target', empty: 'No tables in this schema.' },
  living: { root: '.lerd-root', item: '.lerd-table,.lerd-domain', empty: 'No tables available.' },
  lens: { root: '.nl-root', item: '.nl-card', empty: /No tables/i },
  domains: { root: '.dm-root', item: '.dm-node', empty: 'No tables in this schema.' },
  matrix: { root: '.schema-matrix', item: '.schema-matrix-surface canvas,.schema-matrix-surface svg', empty: 'No tables in this schema.' },
  arcs: { root: '.schema-arc', item: '.schema-arc-node', empty: 'No tables in this schema.' },
  diff: { root: '.sd-root', item: '.sd-node', empty: 'Snapshot A is not selected.' },
};
async function inspectorSelection(view) {
  let expected;
  if (view === 'map') { const node = page.locator('.graph-node').first(); expected = await node.getAttribute('data-node'); await node.focus(); await page.keyboard.press('Enter'); }
  else if (['entities','keys','review'].includes(view)) { const node = page.locator('#content [data-table]').first(); expected=await node.getAttribute('data-table'); await node.click(); }
  else if (view === 'fanout') { const node=page.locator('.fanout-table-button').first(); expected=await node.locator('.fanout-table-name').innerText(); await node.click(); }
  else if (view === 'columns') { const node=page.locator('.ct-group').first(); expected=await node.locator('.ct-table-name').innerText(); await node.getByRole('button',{name:`Inspect table ${expected}`,exact:true}).click(); }
  else if (view === 'city') { await page.getByRole('button',{name:'Flat map',exact:true}).click(); const node=page.locator('.schema-city-target').first(); expected=(await node.getAttribute('aria-label')).split(' · ')[0];await node.focus();await page.keyboard.press('Enter'); }
  else if (view === 'living') { expected=report.schema.firstId;const input=page.getByRole('textbox',{name:'Search tables',exact:true});await input.fill(expected);await input.press('Enter'); }
  else if (view === 'lens') { const node=page.locator('.nl-card').first();expected=await node.getAttribute('data-table');await node.locator('.nl-table-name').click(); }
  else if (view === 'domains') { const node=page.locator('.dm-node').first();expected=(await node.locator('title').textContent()).split('\n')[0];await node.focus();await page.keyboard.press('Enter'); }
  else if (view === 'arcs') { const node=page.locator('.schema-arc-node').first();expected=await node.locator('title').textContent();await node.focus();await page.keyboard.press('Enter'); }
  else if (view === 'matrix') { const grid=page.getByRole('grid');await grid.focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter'); }
  else if (view === 'diff') { expected=await page.getByRole('combobox',{name:'Inspect comparison table',exact:true}).inputValue();await page.getByRole('button',{name:'Inspect table in schema explorer',exact:true}).click(); }
  await page.locator('#side').waitFor({state:'visible'});
  const actual=(await page.locator('#detail h2').innerText()).replaceAll('\u200b','');
  if(expected)assert.equal(actual,expected);
  else assert.ok(report.schema.ids.includes(actual),`Unknown inspector table ${actual}`);
  if(view==='matrix')assert.equal(await page.locator('#inspectorTitle').innerText(),'Relationship inspector');
  await settle();
  return {expected,actual};
}
async function cityChecks() {
  const canvas=page.locator('.schema-city canvas');
  if(!await check('WebGL initializes',async()=>{await canvas.waitFor();await page.waitForFunction(()=>document.querySelector('.schema-city canvas')?.width>100);await settle(500);}))return;
  await check('WebGL canvas contains real geometry',async()=>{const stats=pixels(await canvas.screenshot());assert.ok((stats.grayGeometry>100||stats.colorful>300)&&stats.colors>30,JSON.stringify(stats));return stats;});
  await check('Zoomed 3D left drag on blank scene pans without selection',()=>cityDragCheck('3d',false,'left'));
  await check('Zoomed 3D left drag on persistent label pans without selection',()=>cityDragCheck('3d',true,'left'));
  await check('Zoomed 3D right drag on blank scene orbits without selection',()=>cityDragCheck('3d',false,'right'));
  await check('Zoomed 3D right drag on persistent label orbits without selection',()=>cityDragCheck('3d',true,'right'));
  await closeInspector();
  await page.getByRole('button',{name:'Fit city',exact:true}).click();await settle(250);
  await screenshot('-3d');
  await check('Unknown row counts stay unprofiled in City',async()=>{assert.match(await page.locator('.schema-city-summary').innerText(),new RegExp(`${report.schema.tables} tables\\s*·\\s*${report.schema.tables-report.schema.knownRowCounts} unprofiled`));});
  if(current.width===1366) await check('3D building click opens matching inspector',async()=>{
    const image=PNG.sync.read(await canvas.screenshot()), box=await canvas.boundingBox();let selected;
    const candidates=[];
    for(let y=0;y<image.height;y+=9)for(let x=0;x<image.width;x+=9){const at=(y*image.width+x)*4;const [r,g,b]=image.data.subarray(at,at+3),high=Math.max(r,g,b),low=Math.min(r,g,b);if((high-low>25&&high>75)||(high-low<25&&high>100&&high<235))candidates.push({x,y});}
    const stride=Math.max(1,Math.floor(candidates.length/60));
    for(let i=0;i<candidates.length;i+=stride){const p=candidates[i],x=box.x+p.x*box.width/image.width,y=box.y+p.y*box.height/image.height;
      if(!await page.evaluate(({x,y})=>document.elementFromPoint(x,y)===document.querySelector('.schema-city canvas'),{x,y}))continue;
      await page.mouse.move(x,y);await settle(25);const tip=page.locator('.schema-city-tooltip');if(await tip.count()){selected=await tip.locator('strong').innerText();await page.mouse.click(x,y);break;}}
    assert.ok(selected,'No building picked from rendered surfaces without label interception');assert.equal((await page.locator('#detail h2').innerText()).replaceAll('\u200b',''),selected);return {selected};
  });
  await closeInspector();
  await check('Flat fallback has every table and honest unknown labels',async()=>{await page.getByRole('button',{name:'Flat map',exact:true}).click();assert.equal(await page.locator('.schema-city-target').count(),report.schema.tables);assert.match(await page.locator('.schema-city-target').first().getAttribute('aria-label'),/unknown|unprofiled/i);});
  await screenshot('-flat');
  await check('Zoomed flat left drag on blank scene pans without selection',()=>cityDragCheck('flat',false,'left'));
  await check('Zoomed flat left drag on persistent label pans without selection',()=>cityDragCheck('flat',true,'left'));
  await closeInspector();
  if(current.width===390) await check('Lost WebGL context falls back to selectable flat map',async()=>{
    await page.getByRole('button',{name:'3D city',exact:true}).click();await canvas.waitFor();await settle(200);
    await canvas.evaluate(node=>node.dispatchEvent(new Event('webglcontextlost',{cancelable:true})));
    await page.getByText('WebGL unavailable · Flat map active',{exact:true}).waitFor();assert.equal(await page.locator('.schema-city-target').count(),report.schema.tables);assert.equal(await page.getByRole('button',{name:'3D city',exact:true}).isDisabled(),true);
  });
}
async function testView(view) {
  current.view=view;
  const errorStart=report.pageErrors.length;
  await check('Tab opens',async()=>{await page.locator(`#tab-${view}`).click();await page.locator(viewSpecs[view]?.root || '#extensionHost').waitFor();await settle(view==='living'?650:250);assert.doesNotMatch(await page.locator('#content').innerText(),/View unavailable|Extension bundle unavailable/);});
  const spec=viewSpecs[view];
  await boundsCheck();
  if(view==='diff')await check(`Current snapshot comparison has ${report.schema.tables} unchanged tables`,async()=>{await page.getByRole('button',{name:'Use current graph as A',exact:true}).click();await page.locator('.sd-node').first().waitFor();assert.equal(await page.locator('.sd-node.sd-status-unchanged').count(),report.schema.tables);assert.equal(await page.locator('.sd-node:not(.sd-status-unchanged)').count(),0);});
  if(spec)await check('View has finite, nonblank content',async()=>{
    assert.ok(await page.locator(spec.item).count()>0,`No ${spec.item}`);
    const state=await page.locator(spec.root).evaluate(root=>({rect:root.getBoundingClientRect().toJSON(),invalid:[...root.querySelectorAll('svg path')].filter(p=>/NaN|Infinity/.test(p.getAttribute('d')||'')).length}));
    assert.ok(state.rect.width>100&&state.rect.height>100,JSON.stringify(state));assert.equal(state.invalid,0);return state;
  });
  await screenshot();
  if(view==='living')await check('Fit diagram contains every domain label',async()=>{await page.getByRole('button',{name:'Fit diagram',exact:true}).click();await settle(500);const labels=await labelVisibility('.lerd-domain strong','.lerd-canvas');assert.equal(labels.contained,labels.total,JSON.stringify(labels));return labels;});
  if(view==='arcs')await check('Arc first viewport exposes table labels',async()=>{const labels=await labelVisibility('.schema-arc-node text','.schema-arc-chart');assert.ok(labels.visible>0,JSON.stringify(labels));return labels;});
  if(view==='domains') {
    await check('Domains first viewport exposes table labels',async()=>{const labels=await labelVisibility('.dm-node text','.dm-viewport');assert.ok(labels.visible>0,JSON.stringify(labels));return labels;});
    await check('Domain fit exposes table labels',async()=>{await page.getByRole('button',{name:'Fit domain diagram',exact:true}).click();await settle(200);const labels=await labelVisibility('.dm-node text','.dm-viewport');assert.ok(labels.visible>0,JSON.stringify(labels));return labels;});
    await screenshot('-fit');
  }
  if(!['map','entities','keys','review'].includes(view))await check('Snapshot footer reports unknown counts and no live connection',async()=>{assert.equal(await page.locator('#status').innerText(),`${report.schema.tables} tables | Snapshot only | ${report.schema.knownRowCounts} known row counts`);});
  if(view==='city')await cityChecks();
  await check('Selecting table updates shared inspector',async()=>inspectorSelection(view));
  await boundsCheck('Inspector containment after selection');
  if(current.width===390)await screenshot('-inspector');
  await closeInspector();
  if(current.width===1366&&view==='living')await check('Global export format matches accessible command',async()=>{
    const label=await page.locator('#export').getAttribute('aria-label');const pending=page.waitForEvent('download');await page.locator('#export').click();const downloaded=await pending;const filename=downloaded.suggestedFilename();assert.ok(!/CSV/i.test(label)||filename.endsWith('.csv'),`${label} downloads ${filename}`);return {label,filename};
  });
  await check('Global filter passes an empty graph without stale entities',async()=>{
    await page.locator('#search').fill('__schema_qa_no_matching_table_93d5__');await settle(view==='city'?400:200);
    assert.match(await page.locator('#status').innerText(),new RegExp(`^0 (\\/ ${report.schema.tables} entities|tables)`));
    if(spec)await page.locator('#content').getByText(spec.empty,{exact:typeof spec.empty==='string'}).first().waitFor();
    if(spec)assert.equal(await page.locator(spec.item).count(),0,`Stale ${spec.item} after empty filter`);
  });
  await boundsCheck('Empty filtered view containment');
  if(current.width===390)await screenshot('-empty');
  await page.locator('#search').fill('');await settle(200);
  await check('No page exceptions through view lifecycle',async()=>{assert.deepEqual(report.pageErrors.slice(errorStart),[]);});
  console.log(`Checked ${current.width}/${view}`);
}
try {
  for(const width of widths) {
    current={width,view:'startup'};
    context=await browser.newContext({viewport:{width,height:width===1920?1080:width===390?844:768},deviceScaleFactor:1,acceptDownloads:true});
    page=await context.newPage();page.setDefaultTimeout(7000);page.setDefaultNavigationTimeout(20000);
    page.on('pageerror',error=>report.pageErrors.push({...current,message:error.message,stack:error.stack}));
    page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push({...current,message:message.text()});});
    page.on('request',request=>{if(/^https?:/i.test(request.url()))report.externalRequests.push({...current,url:request.url()});});
    await page.goto(pathToFileURL(captured).href);await page.locator('.graph-node').first().waitFor();
    if(!report.schema) {
      report.schema=await page.evaluate(()=>{const data=window.schemaSnapshot();return {tables:data.tables.length,columns:data.tables.reduce((sum,t)=>sum+t.allColumns.length,0),links:data.links.length,knownRowCounts:data.tables.filter(t=>typeof t.rowCount==='number'&&Number.isFinite(t.rowCount)).length,firstId:data.tables[0].id,ids:data.tables.map(t=>t.id),source:data.source};});
      report.availableViews=await page.locator('[data-view]').evaluateAll(nodes=>nodes.map(node=>({id:node.dataset.view,label:node.textContent.trim(),disabled:node.disabled})));
      report.skipped=report.availableViews.filter(view=>view.id==='diff'&&args.includes('--skip-diff')).map(view=>({view:view.id,reason:'Explicitly skipped by --skip-diff'}));
    }
    await check('Provenance counts match the embedded snapshot',async()=>{assert.ok(report.schema.tables>0&&report.schema.columns>0,JSON.stringify(report.schema));assert.match(await page.locator('#provenance').innerText(),new RegExp(`${report.schema.tables} tables \\| ${escapeRegExp(formatCount(report.schema.columns))} columns`));return {tables:report.schema.tables,columns:report.schema.columns,knownRowCounts:report.schema.knownRowCounts};});
    await closeInspector();
    const views=report.availableViews.filter(view=>!view.disabled&&(view.id!=='diff'||!args.includes('--skip-diff'))&&(!requestedViews||requestedViews.includes(view.id))).map(view=>view.id);
    for(const view of views)await testView(view);
    if(width===390&&views.includes('city')) {
      current.view='city-no-webgl';
      await page.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(String(type).startsWith('webgl'))return null;return original.call(this,type,...args);};});
      await check('Unavailable WebGL starts directly in flat fallback',async()=>{await page.reload();await page.locator('#tab-city').click();await page.getByText('WebGL unavailable · Flat map active',{exact:true}).waitFor();assert.equal(await page.locator('.schema-city-target').count(),report.schema.tables);const target=page.locator('.schema-city-target').first();await target.focus();await page.keyboard.press('Enter');assert.ok(await page.locator('#side').isVisible());});
      await screenshot();
    }
    await context.close();context=undefined;
  }
  if(args.includes('--sample-fixture')) {
    current={width:1366,view:'isolated-local-living-samples'};
    await check('Local Living ERD accepts top-level and legacy samples with max three values',async()=>{
      const {build}=await explorerEsbuild();
      const component=join(dirname(fileURLToPath(import.meta.url)),'../packages/explorer/src/LivingERD.tsx');
      const fixture=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import LivingERD from './LivingERD';const base={name:'id',type:'integer',pk:true,fk:'',nullable:'False',index:false,unique:false};const variants=[['top',{sampleValues:[1,2,3,4]}],['nested',{profiling:{sampleValues:[5,6,7,8]}}],['both',{sampleValues:[9,10,11,12],profiling:{sampleValues:[99]}}],['none',{}]];const graph={project:{key:'isolated-sample-fixture',name:'Fixture',dialect:'postgres'},tables:variants.map(([id,extra])=>({id,name:id,className:id,domain:'Fixture',type:'table',pk:'id',primaryKey:['id'],allColumns:[{...base,...extra}],indexes:[],uniques:[]})),links:[]};createRoot(document.getElementById('root')).render(<LivingERD graph={graph} onSelectTable={()=>{}}/>);`,resolveDir:dirname(component),loader:'tsx'},bundle:true,write:false,format:'iife',outfile:'living-sample-fixture.js',jsx:'automatic',logLevel:'silent'});
      const js=fixture.outputFiles.find(file=>file.path.endsWith('.js')).text,css=fixture.outputFiles.find(file=>file.path.endsWith('.css')).text;
      const fixturePath=join(output,'isolated-living-samples.html');
      await writeFile(fixturePath,`<!doctype html><style>:root{--bg:#101316;--panel:#1b2025;--raised:#272e34;--ink:#e6eaed;--muted:#a5b0ba;--line:#3b444c;--accent:#62c9b2}body{margin:0}#root{height:100dvh;width:100%}${css}</style><div id="root"></div><script>${js.replaceAll('</script','<\\/script')}</script>`);
      context=await browser.newContext({viewport:{width:1366,height:768}});page=await context.newPage();await page.goto(pathToFileURL(fixturePath).href);
      const observed={};
      for(const [id,values]of [['top',['1','2','3']],['nested',['5','6','7']],['both',['9','10','11']],['none',[]]]){const search=page.getByRole('textbox',{name:'Search tables',exact:true});await search.fill(id);await search.press('Enter');await settle(450);const actual=await page.locator(`.react-flow__node[data-id="${id}"] .lerd-samples code`).allTextContents();assert.deepEqual(actual,values);observed[id]=actual;}
      await screenshot();return {component,componentSha256:digest(await readFile(component)),fixture:fixturePath,observed};
    });
    await context?.close();context=undefined;
  }
} catch(error) {
  report.checks.push({...current,name:'Runner reached every requested view',passed:false,error:error.stack||String(error)});
} finally {
  await context?.close();await browser.close();
  report.completedAt=new Date().toISOString();
  report.inputChangedDuringRun=digest(await readFile(input))!==report.sha256;
  report.checks.push({width:0,view:'all',name:'Standalone artifact made no network requests',passed:report.externalRequests.length===0,evidence:report.externalRequests});
  report.summary={passed:report.checks.filter(check=>check.passed).length,failed:report.checks.filter(check=>!check.passed).length,pageErrors:report.pageErrors.length};
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
  const failed=report.checks.filter(check=>!check.passed);
  const markdown=[`# Integrated Schema Explorer QA`, '', `Input: ${input}`, `SHA-256: ${report.sha256}`, `Captured bytes changed at source during run: ${report.inputChangedDuringRun}`, '', `${report.summary.passed} checks passed; ${report.summary.failed} failed; ${report.pageErrors.length} page exceptions.`, '', `Source: ${report.schema?.tables} tables, ${report.schema?.columns} columns, ${report.schema?.knownRowCounts} known row counts.`, '', '## Findings', '', ...failed.map(check=>`- **${check.width}/${check.view}: ${check.name}**: ${check.error?.replaceAll('\n',' ').slice(0,1600)||JSON.stringify(check.evidence)}`), '', '## Skipped', '', ...report.skipped.map(item=>`- ${item.view}: ${item.reason}`), '', '## Screenshots', '', ...report.screenshots.map(name=>`- [${name}](${name})`), ''].join('\n');
  await writeFile(join(output,'report.md'),markdown);
  console.log(JSON.stringify({output,...report.summary,inputChangedDuringRun:report.inputChangedDuringRun}));
  if(report.summary.failed)process.exitCode=1;
}

// Helpers are function declarations so that they are hoisted above the top-level code.
/** Requires an optional runtime dependency; exits 2 with instructions when it is not installed. */
function loadDependency(name) {
  try {
    return require(name);
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes(`'${name}'`)) throw error;
    console.error(`verify_host: cannot find "${name}". Install the browser toolchain (S02 pins @playwright/test and pngjs as root devDependencies) or point NODE_PATH at a directory that contains it.`);
    process.exit(2);
  }
}
/** Imports esbuild from packages/explorer's locked dependencies (the --local-living and --sample-fixture bundles). */
async function explorerEsbuild() {
  const explorerRequire = createRequire(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../packages/explorer/package.json')).href);
  const loaded = await import(pathToFileURL(explorerRequire.resolve('esbuild')).href);
  return typeof loaded.build === 'function' ? loaded : loaded.default;
}
/** Formats a count the way the host page does (`Number.prototype.toLocaleString` under the en-US default locale). */
function formatCount(value) {
  return value.toLocaleString('en-US');
}
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
