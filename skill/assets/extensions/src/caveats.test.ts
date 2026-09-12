// Caveat mirror test (work package C03, CTQ-13, traceability rules DL-04 and DL-05).
//
// `docs/reference/caveats.md` is the only place a caveat is authored. This test re-reads that file
// and asserts that `caveat-strings.ts` carries the same sixteen ids, the same headings, and the
// same blockquote text after whitespace normalisation - so a wording change that misses the mirror
// fails here rather than reaching a user as a paraphrase.
//
// It reads the source document three directories up. The repository has it; the portable skill
// carries a copy of `packages/explorer/src` without `docs/`, so this one file is not part of the
// skill copy's runnable set. Nothing else in the module depends on the document at run time: the
// strings are inlined in `caveat-strings.ts`.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CAVEATS, CAVEAT_IDS, caveatText, type CaveatId } from './caveat-strings';

const SOURCE = new URL('../../../docs/reference/caveats.md', import.meta.url);

/** Collapses every run of whitespace to one space and trims, per DL-05. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Every `## C## <title>` heading of the source document with its first blockquote. */
function readSource(): Map<string, { title: string; text: string }> {
  assert.ok(existsSync(SOURCE), `expected the caveat source document at ${SOURCE.pathname}`);
  const markdown = readFileSync(SOURCE, 'utf8');
  const headings = [...markdown.matchAll(/^## (C\d\d) (.+)$/gm)];
  const found = new Map<string, { title: string; text: string }>();
  for (const [index, heading] of headings.entries()) {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index ?? markdown.length : markdown.length;
    const body = markdown.slice(start, end);
    const quote = body.match(/^>[ \t]?(.*)$/m);
    assert.ok(quote, `${heading[1]} has no blockquote in the source document`);
    assert.ok(!found.has(heading[1]), `${heading[1]} appears twice in the source document`);
    found.set(heading[1], { title: normalize(heading[2]), text: normalize(quote[1]) });
  }
  return found;
}

test('CTQ-13 caveat-strings.ts mirrors every id of docs/reference/caveats.md', () => {
  const source = readSource();
  assert.equal(source.size, 16, 'the source document should author sixteen caveats');
  assert.deepEqual([...source.keys()], [...CAVEAT_IDS], 'ids and their order must match the source document');
  assert.deepEqual(Object.keys(CAVEATS), [...CAVEAT_IDS], 'CAVEATS must hold exactly the declared ids');
  for (const id of CAVEAT_IDS) {
    assert.equal(CAVEATS[id].id, id, `${id} should carry its own id`);
  }
});

test('CTQ-13 every mirrored title and text equals the source after whitespace normalisation', () => {
  const source = readSource();
  for (const [id, expected] of source) {
    const mirrored = CAVEATS[id as CaveatId];
    assert.ok(mirrored, `${id} is authored in the source document but missing from the mirror`);
    assert.equal(normalize(mirrored.title), expected.title, `${id} title`);
    assert.equal(normalize(mirrored.text), expected.text, `${id} text`);
    assert.equal(normalize(caveatText(id as CaveatId)), expected.text, `${id} via caveatText`);
    assert.ok(mirrored.text.length > 0, `${id} text must not be empty`);
  }
  for (const id of CAVEAT_IDS) {
    assert.ok(source.has(id), `${id} is mirrored but not authored in the source document`);
  }
  assert.throws(() => caveatText('C17' as CaveatId), /unknown caveat id C17/);
});

test('CTQ-13 the mirrored text is stored as authored, with no added whitespace to normalise', () => {
  // The mirror is read by the user interface verbatim, so the stored strings must already be the
  // canonical single-line form; normalisation exists for the document side, not for this file.
  for (const id of CAVEAT_IDS) {
    assert.equal(CAVEATS[id].text, normalize(CAVEATS[id].text), `${id} text should need no normalisation`);
    assert.equal(CAVEATS[id].title, normalize(CAVEATS[id].title), `${id} title should need no normalisation`);
  }
});
