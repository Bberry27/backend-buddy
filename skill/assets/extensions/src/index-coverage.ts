/**
 * F03 B11: which partial indexes still cover lookups by their key.
 *
 * A partial index only holds the rows its filter admits, so in general it cannot answer a lookup
 * by its key columns, and the views leave it out of full coverage. One shape is the exception: a
 * filter that only says the leading key columns are not null, `(parent_id IS NOT NULL)`. An equality
 * lookup or join on those columns (`parent_id = $1`, the referential check a parent delete runs)
 * implies the same thing, so the index can serve it.
 *
 * The filter text is display-only (C04); it is parsed here and never executed. Anything the parser
 * does not recognise exactly, an OR, a comparison, a function, a guard on another column, counts as
 * an ordinary partial index. The host page carries a compact copy of `nullGuardColumns` for its
 * PK / FK index; `index-coverage.test.ts` checks the two agree.
 */

const IDENTIFIER = /^(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))\s+IS\s+NOT\s+NULL$/i;

/** Removes whitespace and any pairs of parentheses that wrap the whole text. */
function unwrap(text: string): string {
  let value = text.trim();
  while (value.startsWith('(') && closingParen(value, 0) === value.length - 1) value = value.slice(1, -1).trim();
  return value;
}

/** Index of the parenthesis that closes the one at `open`, outside quoted text, or -1. */
function closingParen(text: string, open: number): number {
  let depth = 0, quote = '';
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '[') quote = ']';
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return index;
  }
  return -1;
}

/** Splits on AND outside parentheses and quoted text; null when the text is unbalanced. */
function conjuncts(text: string): string[] | null {
  const parts: string[] = [];
  let depth = 0, quote = '', start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '[') quote = ']';
    else if (char === '(') depth++;
    else if (char === ')') { if (--depth < 0) return null; }
    else if (depth === 0 && /\s/.test(char)) {
      const match = /^\s+AND\s+/i.exec(text.slice(index));
      if (match) { parts.push(text.slice(start, index)); index += match[0].length - 1; start = index + 1; }
    }
  }
  if (depth || quote) return null;
  parts.push(text.slice(start));
  return parts;
}

/**
 * The columns a partial-index filter requires to be non-null, resolved against the table's column
 * names, when the filter says nothing else. Null for any other filter. A quoted name must match
 * exactly; an unquoted one matches without regard to case, as unquoted identifiers do in SQL.
 */
export function nullGuardColumns(predicate: string | undefined, columns: readonly string[]): string[] | null {
  if (typeof predicate !== 'string' || !predicate.trim()) return null;
  const terms = conjuncts(unwrap(predicate));
  if (!terms) return null;
  const guarded: string[] = [];
  for (const term of terms) {
    const match = IDENTIFIER.exec(unwrap(term));
    if (!match) return null;
    const quoted = match[1]?.replace(/""/g, '"') ?? match[2] ?? match[3];
    const name = quoted ?? columns.find(column => column.toLowerCase() === match[4].toLowerCase());
    if (name === undefined || !columns.includes(name)) return null;
    if (!guarded.includes(name)) guarded.push(name);
  }
  return guarded;
}

export interface CoverageIndex {
  name?: string;
  columns: readonly string[];
  partial?: boolean;
  expression?: boolean;
  predicate?: string;
}

/**
 * Whether `index` serves equality lookups on `lookup`, in that order (a single FK column, or the
 * ordered columns of a composite FK): a plain index whose columns start with `lookup`, or a
 * partial one whose filter only requires columns of `lookup` to be non-null.
 */
export function coversLookup(index: CoverageIndex, lookup: readonly string[], columns: readonly string[]): boolean {
  if (index.expression || !lookup.length || index.columns.length < lookup.length) return false;
  if (!lookup.every((name, position) => index.columns[position] === name)) return false;
  if (!index.partial && !index.predicate) return true;
  const guarded = nullGuardColumns(index.predicate, columns);
  return guarded !== null && guarded.every(name => lookup.includes(name));
}

/** How a partial index that leads with the column is described, filter included when recorded. */
export function partialCondition(index: CoverageIndex): string {
  return typeof index.predicate === 'string' && index.predicate.trim() ? `WHERE ${index.predicate.trim()}` : 'filter not recorded';
}
