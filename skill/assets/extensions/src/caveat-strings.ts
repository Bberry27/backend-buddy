/**
 * Caveat strings for the user interface (work package C03, feature F14, decision D8, CTQ-13).
 *
 * `docs/reference/caveats.md` is the only place a caveat is authored. This file mirrors it so a
 * view, a menu, a legend or an export footer can show the wording without reaching for a
 * document, and `caveats.test.ts` asserts the two are equal after whitespace normalisation. No
 * surface paraphrases a caveat and no surface writes its own; a string that restates one of the
 * sixteen comes from here.
 *
 * Changing wording is a reviewed change to the source document that updates this mirror, the
 * test, and every quoting document in the same pull request (the wording freezes at gate G0).
 *
 * `caveats.test.ts` reads the source document three directories up, which the repository has and
 * the portable skill does not: the skill carries a copy of `packages/explorer/src` without
 * `docs/`, so that one test is not part of its runnable set. This module itself has no such
 * dependency - the strings are inlined - so every view in the skill copy keeps working.
 */

export type CaveatId =
  | 'C01'
  | 'C02'
  | 'C03'
  | 'C04'
  | 'C05'
  | 'C06'
  | 'C07'
  | 'C08'
  | 'C09'
  | 'C10'
  | 'C11'
  | 'C12'
  | 'C13'
  | 'C14'
  | 'C15'
  | 'C16';

export interface Caveat {
  /** Registry id, C01-C16. */
  id: CaveatId;
  /** The heading text that follows the id in the source document. */
  title: string;
  /** The canonical blockquote, verbatim. */
  text: string;
}

/** The sixteen ids, in registry order. */
export const CAVEAT_IDS: readonly CaveatId[] = Object.freeze([
  'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16',
] as const);

/** The mirror of `docs/reference/caveats.md`, keyed by id. */
export const CAVEATS: Readonly<Record<CaveatId, Caveat>> = Object.freeze({
  C01: Object.freeze({
    id: 'C01',
    title: 'Unknown stays unknown',
    text:
      'Missing row counts and statistics are unknown: never zero, never a substituted value, never a fabricated count. Every visual that encodes a count labels unavailable data as unknown and keeps it distinguishable from a measured zero.',
  }),
  C02: Object.freeze({
    id: 'C02',
    title: 'Fan-out ratios are independent local factors',
    text:
      'A fan-out ratio is child rows divided by parent rows for one relationship. Ratios are independent local factors, not conserved flow: counts along a path are not additive, a ratio is not a proven per-parent multiplicity, and when either count is unknown the ratio is unknown.',
  }),
  C03: Object.freeze({
    id: 'C03',
    title: 'Discovered communities are analytical suggestions',
    text:
      'Discovered communities are analytical suggestions computed from the declared-FK graph. They are structural candidates, not the project\'s business ownership model and not confirmed business domains.',
  }),
  C04: Object.freeze({
    id: 'C04',
    title: 'Migration SQL is a draft and is never executed by the product',
    text:
      'Migration SQL and validation SQL are drafts for human review. The product never executes them, never offers a control that executes them, and never opens a database connection on their behalf.',
  }),
  C05: Object.freeze({
    id: 'C05',
    title: 'Sampled evidence is not proof',
    text:
      'Sampled evidence is not proof. A capped sample cannot establish an exact row count, a functional dependency, uniqueness, or a normal form. The absence of a sampled violation does not earn a clean result, and an unprofiled table is never described as normalized.',
  }),
  C06: Object.freeze({
    id: 'C06',
    title: 'Composite unique membership does not imply single-column uniqueness',
    text:
      'Membership in a composite unique key or composite primary key does not make any member column unique on its own. Uniqueness is stated per key group, and index coverage depends on column order, predicates, and expressions.',
  }),
  C07: Object.freeze({
    id: 'C07',
    title: 'Declared and inferred evidence stay distinguishable',
    text:
      'Declared evidence (from the identified source or catalog) and inferred evidence (from naming or heuristics) are visibly distinguishable in every view, export, and finding. An inferred reference never receives a declared label, and an unresolved inferred target never produces an executable validation query.',
  }),
  C08: Object.freeze({
    id: 'C08',
    title: 'Heuristic findings are review candidates, not verdicts',
    text:
      'Heuristic findings are review candidates, not verdicts. Each finding names its columns, its observable evidence, why it might matter, and what would confirm or dismiss it. A structural heuristic does not prove a normal-form violation, a functional dependency, or a design defect.',
  }),
  C09: Object.freeze({
    id: 'C09',
    title: 'A source checkout or snapshot is not the live database',
    text:
      'A source checkout, ORM model, or stored snapshot documents a schema at one point in time. It is not proof of the live database schema. "Declared" means declared in the identified evidence source, not verified against a live catalog, unless the snapshot\'s provenance says so.',
  }),
  C10: Object.freeze({
    id: 'C10',
    title: 'N:M junction collapse requires key evidence',
    text:
      'A table is collapsed into an N:M junction edge only when its key evidence supports it: exactly two foreign-key groups whose columns are covered by a primary or unique key. A generic multi-FK fact table, a ternary relation, or a junction that is itself referenced is never collapsed into one binary edge.',
  }),
  C11: Object.freeze({
    id: 'C11',
    title: 'A composite FK counts once; association counts are column pairs',
    text:
      'A composite foreign key is one constraint and counts once wherever constraints are counted (matrix cells, community edges, cardinality). The relational map\'s association count is column pairs, not physical FK constraints. Every surface states which of the two it counts.',
  }),
  C12: Object.freeze({
    id: 'C12',
    title: 'Cycles require strongly-connected-component analysis',
    text:
      'A cycle is a strongly connected component of the declared dependency graph with more than one member, or a self-reference. A repeated visit during traversal is not by itself a cycle.',
  }),
  C13: Object.freeze({
    id: 'C13',
    title: 'Browser storage is convenience state; project isolation is mandatory',
    text:
      'Browser storage holds convenience state only: theme, layouts, camera, and local decisions. It is not a team review database. Every stored key is scoped by the project\'s stable key (and, where the data depends on the schema, by the snapshot fingerprint) so that different projects and environments never read or overwrite each other\'s state.',
  }),
  C14: Object.freeze({
    id: 'C14',
    title: 'Never connect to production implicitly; read-only and explicitly selected only',
    text:
      'The product never discovers or connects to a database implicitly, and never to production to make a view look populated. Live access uses only a connection the user explicitly selected, opened read-only with bounded queries, and a metadata request never authorizes scanning customer rows.',
  }),
  C15: Object.freeze({
    id: 'C15',
    title: 'Application defaults are not SQL defaults',
    text:
      'An application-level default (an ORM or code default) is not a SQL default. The two are shown separately, an application default is never emitted as DDL, and a code function is never emitted as executable migration SQL.',
  }),
  C16: Object.freeze({
    id: 'C16',
    title: 'The flat accessible fallback must remain available',
    text:
      'The flat, accessible rendering (flat SVG City, keyboard-reachable tables, text alternatives for canvas and WebGL surfaces) remains available in every release. It uses the same layout data as the 3D scene, can be chosen at any time, and is entered automatically when WebGL is unavailable or lost.',
  }),
});

/** The canonical text for an id. Throws on an id outside C01-C16 rather than showing nothing. */
export function caveatText(id: CaveatId): string {
  const caveat = CAVEATS[id];
  if (!caveat) throw new Error('caveat-strings: unknown caveat id ' + id);
  return caveat.text;
}
