// Mount-policy tests (work package C03, CTQ-10).
//
// The policy is one small function, and the reason it exists is a defect: the artifact used to
// destroy the React tree on every filter keystroke. So the table below is the specification -
// same container and same view is the only case that keeps the root, and both of the other two
// reasons to recreate it are spelled out rather than folded together.
//
// The function compares containers by identity and never touches the DOM, so plain objects stand
// in for elements here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideMount, type MountDecision, type MountTarget } from './mount-policy';

const host = { id: 'extensionHost' };
const replacement = { id: 'extensionHost (rebuilt by the host)' };

test('CTQ-10 a filter keystroke updates the mounted view instead of recreating it', () => {
  const cases: { previous: MountTarget | undefined; next: MountTarget; expected: MountDecision }[] = [
    { previous: undefined, next: { container: host, view: 'city' }, expected: 'create' },
    { previous: { container: host, view: 'city' }, next: { container: host, view: 'city' }, expected: 'update' },
    { previous: { container: host, view: 'city' }, next: { container: host, view: 'living' }, expected: 'recreate' },
    { previous: { container: host, view: 'city' }, next: { container: replacement, view: 'city' }, expected: 'recreate' },
    { previous: { container: host, view: 'city' }, next: { container: replacement, view: 'living' }, expected: 'recreate' },
  ];
  for (const { previous, next, expected } of cases) {
    assert.equal(decideMount(previous, next), expected, `${previous ? previous.view : 'nothing'} -> ${next.view}`);
  }
});

test('CTQ-10 twenty keystrokes on one view produce no second root', () => {
  let mounted: MountTarget | undefined;
  let roots = 0;
  for (let keystroke = 0; keystroke < 20; keystroke++) {
    const next: MountTarget = { container: host, view: 'city' };
    if (decideMount(mounted, next) !== 'update') roots++;
    mounted = next;
  }
  assert.equal(roots, 1);
  // A view switch is the one gesture that costs a root, and it costs exactly one.
  for (const view of ['living', 'matrix', 'city']) {
    const next: MountTarget = { container: host, view };
    if (decideMount(mounted, next) !== 'update') roots++;
    mounted = next;
  }
  assert.equal(roots, 4);
});

test('CTQ-10 an unchanged decision is stable and depends on nothing but container and view', () => {
  const previous: MountTarget = { container: host, view: 'diff' };
  assert.equal(decideMount(previous, { container: host, view: 'diff' }), 'update');
  // A different object with equal contents is a different container: React cannot render into a
  // detached node, so identity is the right comparison.
  assert.equal(decideMount(previous, { container: { id: 'extensionHost' }, view: 'diff' }), 'recreate');
  assert.equal(decideMount(previous, { container: host, view: '' }), 'recreate');
});
