// Tests for the text hygiene rules the repository declares in .editorconfig and
// .gitattributes (R00): every tracked text file uses LF line endings and ends with a
// newline. The file list comes from the private-data guard's listFiles(), so the test sees
// the same files as CI (git mode) and as a plain directory export (walk mode). Generated
// directories and binary files (a NUL byte in the first 8 KiB) are skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles } from './private_data_guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NUL_SNIFF_BYTES = 8192;
const GENERATED_DIRS = new Set(['node_modules', 'dist', '__pycache__']);
const CR = 0x0d;
const LF = 0x0a;
// A repository export always has more text files than this; a smaller count means the
// listing broke and the hygiene assertions below would pass vacuously.
const MIN_EXPECTED_TEXT_FILES = 50;

function isGenerated(rel) {
  return rel.split('/').some((segment) => GENERATED_DIRS.has(segment));
}

function isBinary(bytes) {
  return bytes.subarray(0, NUL_SNIFF_BYTES).includes(0);
}

/** Lists { rel, bytes } for every non-empty text file the guard would scan. */
function textFiles(root) {
  const warnings = [];
  const { files, mode } = listFiles(root, warnings);
  const out = [];
  for (const rel of files) {
    if (isGenerated(rel)) continue;
    let bytes;
    try {
      bytes = readFileSync(join(root, rel));
    } catch {
      continue; // dangling symbolic link or a file removed while listing
    }
    if (bytes.length === 0 || isBinary(bytes)) continue;
    out.push({ rel, bytes });
  }
  return { mode, warnings, files: out };
}

/** Returns the paths that contain a carriage return and the paths missing a final newline. */
function hygieneViolations(files) {
  const carriageReturn = [];
  const noFinalNewline = [];
  for (const { rel, bytes } of files) {
    if (bytes.includes(CR)) carriageReturn.push(rel);
    if (bytes[bytes.length - 1] !== LF) noFinalNewline.push(rel);
  }
  return { carriageReturn, noFinalNewline };
}

const scanned = textFiles(ROOT);

test('hygieneViolations reports carriage returns and a missing final newline', () => {
  const files = [
    { rel: 'ok.txt', bytes: Buffer.from('one\ntwo\n') },
    { rel: 'crlf.txt', bytes: Buffer.from('one\r\ntwo\r\n') },
    { rel: 'lone-cr.txt', bytes: Buffer.from('one\rtwo\n') },
    { rel: 'no-newline.txt', bytes: Buffer.from('one\ntwo') },
  ];
  assert.deepEqual(hygieneViolations(files), {
    carriageReturn: ['crlf.txt', 'lone-cr.txt'],
    noFinalNewline: ['no-newline.txt'],
  });
});

test('the repository declares LF line endings and a final newline', () => {
  const editorconfig = readFileSync(join(ROOT, '.editorconfig'), 'utf8');
  assert.match(editorconfig, /^end_of_line = lf$/m);
  assert.match(editorconfig, /^insert_final_newline = true$/m);
  const gitattributes = readFileSync(join(ROOT, '.gitattributes'), 'utf8');
  assert.match(gitattributes, /^\* text=auto eol=lf$/m);
});

test('the listing covers the repository', () => {
  assert.deepEqual(scanned.warnings, []);
  assert.ok(
    scanned.files.length >= MIN_EXPECTED_TEXT_FILES,
    `expected at least ${MIN_EXPECTED_TEXT_FILES} text files in ${scanned.mode} mode, saw ${scanned.files.length}`,
  );
});

test('every tracked text file uses LF line endings', () => {
  const { carriageReturn } = hygieneViolations(scanned.files);
  assert.deepEqual(carriageReturn, [], `files with CR bytes (${scanned.mode} mode); re-save them with LF endings`);
});

test('every tracked text file ends with a newline', () => {
  const { noFinalNewline } = hygieneViolations(scanned.files);
  assert.deepEqual(noFinalNewline, [], `files without a final newline (${scanned.mode} mode)`);
});
