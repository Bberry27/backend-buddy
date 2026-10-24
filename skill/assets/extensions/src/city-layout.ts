import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import type { SchemaGraph } from './types';

export type CityTable = SchemaGraph['tables'][number];
export type CityPoint = [number, number];
export interface CityDistrict {
  id: string; color: string; x: number; z: number; width: number; depth: number;
}
export interface CityBuilding {
  id: string; table: CityTable; domain: string; color: string;
  x: number; z: number; width: number; depth: number; height: number;
  rowCount: number | null; aisle: number;
}
export interface CityRoad {
  id: string; source: string; target: string; points: CityPoint[];
  width: number; crossDistrict: boolean; inferred: boolean; ratio: number | null;
}
export interface CityLayout {
  width: number; depth: number; maxHeight: number;
  districts: CityDistrict[]; buildings: CityBuilding[]; roads: CityRoad[];
  basis: CityHeightBasis;
}

export interface CityLabelAnchor {
  building: CityBuilding; x: number; y: number; projectedWidth: number; priority: boolean;
}
export interface CityLabelPlacement extends CityLabelAnchor {
  left: number; top: number; width: number; height: number; lines: string[]; members: CityBuilding[];
}

// How many names the city shows at once. Every table carrying a label reads as noise on a schema
// of any size -- 171 tables put forty overlapping pills over the buildings they describe -- so the
// default names the ones the city is drawing attention to and the rest answer on hover.
export type CityLabelDensity = 'prominent' | 'all' | 'selected';

export const CITY_PROMINENT_LABELS = 20;

export const CITY_LABEL_DENSITIES: { id: CityLabelDensity; label: string; title: string }[] = [
  { id: 'prominent', label: 'Prominent',
    title: `The ${CITY_PROMINENT_LABELS} tallest by the current height basis, plus whatever is hovered or selected. Everything else names itself on hover.` },
  { id: 'all', label: 'All',
    title: 'Every table that fits. Names that would overlap are grouped into the nearest label and counted as +N.' },
  { id: 'selected', label: 'Selected only',
    title: 'Only what is hovered or selected, for reading the shape of the city without its names.' },
];

/**
 * The ids allowed a label at this density. `keep` is always allowed, whatever the density: the
 * thing a user is pointing at must be able to name itself, and that is what makes hiding the rest
 * safe rather than a loss of information.
 *
 * `prominent` ranks by height, so it follows whichever basis the city is sizing by rather than
 * being a second, competing definition of what matters.
 */
export function cityLabelled(buildings: CityBuilding[], density: CityLabelDensity,
                             keep: ReadonlySet<string>,
                             limit = CITY_PROMINENT_LABELS): Set<string> {
  if (density === 'all') return new Set(buildings.map(building => building.id));
  const allowed = new Set(keep);
  if (density === 'selected') return allowed;
  const ranked = [...buildings].sort((a, b) => b.height - a.height || compare(a.id, b.id));
  for (const building of ranked.slice(0, Math.max(0, limit))) allowed.add(building.id);
  return allowed;
}

// Pixel-space labels keep the same readable font size at every camera distance.
// Unplaced names join a nearby named label rather than becoming overlapping text.
export function placeCityLabels(anchors: CityLabelAnchor[], width: number, height: number): CityLabelPlacement[] {
  const placed: CityLabelPlacement[] = [], pending: CityLabelAnchor[] = [];
  const visible = anchors.filter(anchor => anchor.x >= 0 && anchor.y >= 0 && anchor.x <= width && anchor.y <= height)
    .sort((a, b) => Number(b.priority) - Number(a.priority) || b.projectedWidth - a.projectedWidth || compare(a.building.id, b.building.id));
  for (const anchor of visible) {
    const name = anchor.building.table.name || anchor.building.id;
    const detailed = anchor.priority || anchor.projectedWidth >= 28;
    const maxChars = detailed ? Math.max(10, Math.min(34, Math.floor((width - 52) / 6.5))) : 22;
    const lines: string[] = [];
    let remaining = name;
    while (remaining.length > maxChars) {
      if (!detailed && lines.length === 1) { lines.push(`${remaining.slice(0, maxChars - 3)}...`); remaining = ''; break; }
      const boundary = Math.max(remaining.lastIndexOf('_', maxChars - 1), remaining.lastIndexOf(' ', maxChars - 1)) + 1;
      const end = boundary >= maxChars / 3 ? boundary : maxChars;
      lines.push(remaining.slice(0, end)); remaining = remaining.slice(end);
    }
    if (remaining) lines.push(remaining);
    const boxWidth = Math.min(width - 12, Math.max(...lines.map(line => line.length)) * 6.5 + 38);
    const boxHeight = lines.length * 14 + 6;
    const candidates = [[-boxWidth / 2, -boxHeight - 5], [-boxWidth / 2, 7],
      [8, -boxHeight / 2], [-boxWidth - 8, -boxHeight / 2],
      [-boxWidth / 2, -boxHeight - 28], [-boxWidth / 2, 30],
      [18, -boxHeight - 16], [-boxWidth - 18, -boxHeight - 16]];
    let placement: CityLabelPlacement | undefined;
    for (const [dx, dy] of candidates) {
      const left = Math.max(6, Math.min(width - boxWidth - 6, anchor.x + dx));
      const top = Math.max(6, Math.min(height - boxHeight - 6, anchor.y + dy));
      if (placed.some(label => left < label.left + label.width + 3 && left + boxWidth + 3 > label.left &&
        top < label.top + label.height + 3 && top + boxHeight + 3 > label.top)) continue;
      placement = { ...anchor, left, top, width: boxWidth, height: boxHeight, lines, members: [anchor.building] };
      break;
    }
    if (placement) placed.push(placement); else pending.push(anchor);
  }
  for (const anchor of pending) {
    let closest: CityLabelPlacement | undefined, distance = Infinity;
    for (const label of placed) {
      const next = Math.hypot(anchor.x - label.x, anchor.y - label.y);
      if (next < distance) { closest = label; distance = next; }
    }
    closest?.members.push(anchor.building);
  }
  return placed;
}

const COLORS = ['#38b2ac', '#e9ab47', '#6395ed', '#dd7494', '#91b958', '#ab8bd9', '#e17b55'];
const GAP = 1.2;
const MARGIN = 1.8;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const columns = (table: CityTable) => Math.max(1, table.allColumns.length);
export const cityRowCount = (table: CityTable): number | null =>
  typeof table.rowCount === 'number' && Number.isFinite(table.rowCount) && table.rowCount >= 0
    ? table.rowCount : null;

// What a building's height encodes. `rows` is the only measured basis and the only one that can be
// unknown, so it is the only one that yields a baseline-height building: the guardrail in AGENTS.md
// section 3 forbids standing in a column count for a row count nobody measured. The other two bases
// are declared catalog metadata, always known, and are labelled as themselves in the legend rather
// than presented as a volume proxy.
export type CityHeightBasis = 'rows' | 'columns' | 'indexes';

export const CITY_HEIGHT_BASES: { id: CityHeightBasis; label: string; legend: string; title: string }[] = [
  { id: 'rows', label: 'Rows (measured)', legend: 'Height: log row count',
    title: 'Known row counts use log(1 + row count). Unknown counts keep the minimum height and are never replaced by a substitute number.' },
  { id: 'columns', label: 'Columns (declared)', legend: 'Height: log column count',
    title: 'Height uses log(1 + column count) from catalog metadata. It is a shape measure, not a data-volume measure.' },
  { id: 'indexes', label: 'Indexes (declared)', legend: 'Height: log index count',
    title: 'Height uses log(1 + index count) from catalog metadata. A table with no index is a known zero, not an unknown.' },
];

/** The value a basis measures, or null when it is genuinely unmeasured. Only `rows` can be null. */
export const cityHeightValue = (table: CityTable, basis: CityHeightBasis): number | null =>
  basis === 'rows' ? cityRowCount(table)
    : basis === 'columns' ? table.allColumns.length
      : table.indexes.length;

/**
 * What to tell the reader about the heights they are looking at, or '' when nothing needs saying.
 *
 * A city of uniform baseline buildings looks broken rather than unmeasured, and a legend key alone
 * did not carry that. Only the measured basis can be unknown, so only it needs the sentence, and
 * the wording names both ways out. The artifact opens from a file share with no admin area in
 * reach, so it cannot instruct the reader to go there.
 */
export function cityHeightAdvice(layout: CityLayout): string {
  if (layout.basis !== 'rows' || !layout.buildings.length) return '';
  const unknown = layout.buildings.filter(building => building.rowCount === null).length;
  const measured = layout.buildings.length - unknown;
  if (measured === 0) {
    return 'No row counts in this snapshot, so every building sits at the baseline height. '
      + 'Measure them where this schema was populated, or set Height to a declared basis.';
  }
  if (unknown === 0) return '';
  return `${measured} of ${layout.buildings.length} tables have a measured row count; `
    + `the other ${unknown} sit at the baseline height and are marked ?.`;
}

/** One road into or out of the selected table, with what is known about its load. */
export interface CityTrafficRoad {
  road: CityRoad;
  /** Which way the foreign key points, read from the selected table. */
  direction: 'in' | 'out';
  neighbour: CityBuilding;
  /** Rows on the child side: the rows that actually carry the key. Null when nobody counted them. */
  load: number | null;
  /** Child rows per parent row for this one relationship (C02), or null when either count is unknown. */
  ratio: number | null;
  /** 0 to 1 against the busiest road of this selection. Null keeps an unmeasured road unmeasured. */
  intensity: number | null;
}

/** What the roads at one building add up to. */
export interface CityTraffic {
  building: CityBuilding;
  /** Heaviest first; roads with an unknown load sort last rather than as light ones. */
  roads: CityTrafficRoad[];
  inbound: number;
  outbound: number;
  unknown: number;
  busiest: CityTrafficRoad | null;
}

/**
 * The traffic at one building: which roads touch it, which way each runs, and how heavy it is.
 *
 * Heaviness is the child table's measured row count -- the rows that carry the foreign key -- and
 * not a measurement of queries, which this product never observes. A road whose child count nobody
 * measured keeps a null intensity and is drawn at the baseline width: an unknown load is not a
 * light one (C01), and the ratio beside it stays unknown unless both counts are known (C02).
 */
export function cityTraffic(layout: CityLayout, selectedId: string | null): CityTraffic | null {
  if (!selectedId) return null;
  const byId = new Map(layout.buildings.map(building => [building.id, building]));
  const building = byId.get(selectedId);
  if (!building) return null;

  const roads: CityTrafficRoad[] = [];
  for (const road of layout.roads) {
    const outbound = road.source === selectedId;
    if (!outbound && road.target !== selectedId) continue;
    const neighbour = byId.get(outbound ? road.target : road.source);
    if (!neighbour) continue;
    // The road runs child -> parent, so the child is always its source whichever end is selected.
    const child = outbound ? building : neighbour;
    roads.push({ road, direction: outbound ? 'out' : 'in', neighbour,
      load: child.rowCount, ratio: road.ratio, intensity: null });
  }
  if (!roads.length) return null;

  const busiest = Math.max(0, ...roads.map(entry => entry.load ?? 0));
  const scale = Math.log1p(busiest);
  for (const entry of roads) {
    entry.intensity = entry.load === null ? null : scale > 0 ? Math.log1p(entry.load) / scale : 1;
  }
  roads.sort((a, b) => (b.load ?? -1) - (a.load ?? -1) || compare(a.neighbour.id, b.neighbour.id));
  return {
    building, roads,
    inbound: roads.filter(entry => entry.direction === 'in').length,
    outbound: roads.filter(entry => entry.direction === 'out').length,
    unknown: roads.filter(entry => entry.load === null).length,
    busiest: roads.find(entry => entry.load !== null) || null,
  };
}

/** The roads of a selection, by road id, so a renderer can ask about one road in constant time. */
export const cityTrafficById = (traffic: CityTraffic | null): Map<string, CityTrafficRoad> =>
  new Map((traffic?.roads || []).map(entry => [entry.road.id, entry]));

/**
 * How wide a road draws while a selection is on screen. An unknown load keeps the baseline width
 * it already had, so a road nobody measured never reads as a quiet one.
 */
export const cityTrafficWidth = (road: CityRoad, intensity: number | null): number =>
  road.width * (intensity === null ? 1 : 1.7 + 2.3 * intensity);

/** A fan-out ratio as a person reads it: child rows per single parent row. */
export const cityRatioLabel = (ratio: number): string =>
  `${ratio >= 10 ? Math.round(ratio).toLocaleString() : ratio.toFixed(ratio >= 1 ? 1 : 2)}:1`;

/** One line naming what the roads at this building carry, for the panel heading and its label. */
export function cityTrafficSummary(traffic: CityTraffic): string {
  const name = traffic.building.table.name || traffic.building.id;
  const parts = [`${name}: ${traffic.inbound} inbound, ${traffic.outbound} outbound`];
  if (traffic.busiest) {
    const busiest = traffic.busiest;
    const ratio = busiest.ratio === null ? '' : `, ${cityRatioLabel(busiest.ratio)} per parent row`;
    parts.push(`busiest ${busiest.neighbour.table.name || busiest.neighbour.id} at `
      + `${busiest.load!.toLocaleString()} child rows${ratio}`);
  }
  if (traffic.unknown) {
    parts.push(`${traffic.unknown} with an unknown row count, drawn at the baseline width`);
  }
  return `${parts.join('; ')}.`;
}

export function cityTableLabel(table: CityTable): string {
  const count = cityRowCount(table);
  return `${table.name || table.id} · ${count === null ? 'Unprofiled (row count unknown)' : `${count.toLocaleString()} rows`} · ${table.allColumns.length} columns`;
}

function pack(tables: CityTable[], district: CityDistrict, scale: number) {
  let x = MARGIN, z = MARGIN, rowDepth = 0;
  const rows: { table: CityTable; x: number; z: number; size: number; row: number }[] = [];
  let row = 0;
  const aisles: number[] = [];
  for (const table of tables) {
    const size = Math.sqrt(columns(table)) * scale;
    if (size > district.width - 2 * MARGIN) return null;
    if (x + size > district.width - MARGIN && x > MARGIN) {
      aisles[row] = z + rowDepth + GAP / 2;
      z += rowDepth + GAP; x = MARGIN; rowDepth = 0; row++;
    }
    if (z + size > district.depth - MARGIN) return null;
    rows.push({ table, x, z, size, row });
    x += size + GAP;
    rowDepth = Math.max(rowDepth, size);
  }
  aisles[row] = z + rowDepth + GAP / 2;
  return rows.map(item => ({ ...item, aisle: district.z + aisles[item.row] }));
}

function simplify(points: CityPoint[]): CityPoint[] {
  return points.filter((point, i) => {
    const previous = points[i - 1], next = points[i + 1];
    if (previous && previous[0] === point[0] && previous[1] === point[1]) return false;
    return !previous || !next || !((previous[0] === point[0] && point[0] === next[0]) ||
      (previous[1] === point[1] && point[1] === next[1]));
  });
}

// Route on district boundaries. Interiors are obstacles, so cross-domain roads
// cannot traverse buildings, even when a treemap district sits between endpoints.
function districtRouter(districts: CityDistrict[]) {
  const xs = [...new Set(districts.flatMap(d => [d.x, d.x + d.width]))].sort((a, b) => a - b);
  const zs = [...new Set(districts.flatMap(d => [d.z, d.z + d.depth]))].sort((a, b) => a - b);
  const blocked = (a: CityPoint, b: CityPoint) => districts.some(d => {
    const epsilon = 1e-7;
    if (a[0] === b[0]) return a[0] > d.x + epsilon && a[0] < d.x + d.width - epsilon &&
      Math.max(a[1], b[1]) > d.z + epsilon && Math.min(a[1], b[1]) < d.z + d.depth - epsilon;
    return a[1] > d.z + epsilon && a[1] < d.z + d.depth - epsilon &&
      Math.max(a[0], b[0]) > d.x + epsilon && Math.min(a[0], b[0]) < d.x + d.width - epsilon;
  });
  const cache = new Map<string, CityPoint[]>();
  return (from: CityDistrict, to: CityDistrict): CityPoint[] => {
    const key = JSON.stringify([from.id, to.id]);
    const cached = cache.get(key);
    if (cached) return cached;
    const start = zs.indexOf(from.z) * xs.length + xs.indexOf(from.x);
    const goal = zs.indexOf(to.z) * xs.length + xs.indexOf(to.x);
    const point = (id: number): CityPoint => [xs[id % xs.length], zs[Math.floor(id / xs.length)]];
    const distances = new Map([[start, 0]]), previous = new Map<number, number>();
    const open = new Set([start]);
    while (open.size) {
      let current = -1, best = Infinity;
      for (const id of open) {
        const p = point(id);
        const score = distances.get(id)! + Math.abs(p[0] - to.x) + Math.abs(p[1] - to.z);
        if (score < best) { best = score; current = id; }
      }
      if (current === goal) break;
      open.delete(current);
      const ix = current % xs.length, iz = Math.floor(current / xs.length);
      const neighbors = [ix > 0 ? current - 1 : -1, ix < xs.length - 1 ? current + 1 : -1,
        iz > 0 ? current - xs.length : -1, iz < zs.length - 1 ? current + xs.length : -1];
      for (const next of neighbors) {
        if (next < 0) continue;
        const a = point(current), b = point(next);
        if (blocked(a, b)) continue;
        const distance = distances.get(current)! + Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
        if (distance < (distances.get(next) ?? Infinity)) {
          distances.set(next, distance); previous.set(next, current); open.add(next);
        }
      }
    }
    if (!distances.has(goal)) return [];
    const path: CityPoint[] = [];
    for (let id: number | undefined = goal; id !== undefined; id = previous.get(id)) path.push(point(id));
    const result = simplify(path.reverse());
    cache.set(key, result);
    cache.set(JSON.stringify([to.id, from.id]), [...result].reverse());
    return result;
  };
}

export function layoutCity(graph: SchemaGraph, basis: CityHeightBasis = 'rows'): CityLayout {
  const groups = new Map<string, CityTable[]>();
  for (const table of graph.tables) {
    const domain = table.domain || 'Unassigned';
    const group = groups.get(domain) || [];
    group.push(table); groups.set(domain, group);
  }
  if (!groups.size) return { width: 20, depth: 16, maxHeight: 0, buildings: [], districts: [], roads: [], basis };
  const data = [...groups].sort(([a], [b]) => compare(a, b)).map(([id, tables]) => {
    tables.sort((a, b) => columns(b) - columns(a) || compare(a.id, b.id));
    return { id, weight: tables.reduce((sum, table) => sum + (Math.sqrt(columns(table)) + 5) ** 2, 0) + 64 };
  });
  const weight = data.reduce((sum, domain) => sum + domain.weight, 0);
  const width = Math.max(24, Math.sqrt(weight * 1.35));
  const depth = Math.max(20, Math.sqrt(weight / 1.35));
  type Node = { id: string; weight?: number; children?: Node[] };
  const root = hierarchy<Node>({ id: 'city', children: data }).sum(node => node.weight || 0);
  const tree = treemap<Node>().size([width, depth]).tile(treemapSquarify).paddingInner(3)(root);
  const districts = tree.leaves().map((node, index) => ({ id: node.data.id,
    color: COLORS[index % COLORS.length], x: node.x0, z: node.y0,
    width: node.x1 - node.x0, depth: node.y1 - node.y0 }));
  // One shared scale preserves the area-to-column ratio across every district.
  let low = 0, high = 4;
  for (let step = 0; step < 36; step++) {
    const scale = (low + high) / 2;
    if (districts.every(d => pack(groups.get(d.id)!, d, scale))) low = scale; else high = scale;
  }
  const counts = graph.tables.map(table => cityHeightValue(table, basis)).filter((count): count is number => count !== null);
  const maxLog = Math.max(1, ...counts.map(count => Math.log1p(count)));
  const heightScale = Math.min(width, depth) * 0.22 / maxLog;
  const buildings: CityBuilding[] = districts.flatMap(d => (pack(groups.get(d.id)!, d, low * 0.98) || []).map(item => {
    // rowCount stays the measured row count whatever the height encodes: the tooltip, the
    // unprofiled marker and the road ratio are statements about the data, not about the bars.
    const rowCount = cityRowCount(item.table);
    const value = cityHeightValue(item.table, basis);
    return { id: item.table.id, table: item.table, domain: d.id, color: d.color,
      x: d.x + item.x + item.size / 2, z: d.z + item.z + item.size / 2,
      width: item.size, depth: item.size, height: value === null ? 0.6 : Math.max(0.6, Math.log1p(value) * heightScale),
      rowCount, aisle: item.aisle };
  }));
  const byId = new Map(buildings.map(b => [b.id, b]));
  const byDomain = new Map(districts.map(d => [d.id, d]));
  const route = districtRouter(districts);
  const roads: CityRoad[] = [];
  graph.links.forEach((link, index) => {
    const source = byId.get(link.source), target = byId.get(link.target);
    if (!source || !target || source.id === target.id) return;
    const from = byDomain.get(source.domain)!, to = byDomain.get(target.domain)!;
    const crossDistrict = from.id !== to.id;
    const middle = crossDistrict ? route(from, to) : [];
    if (crossDistrict && !middle.length) return;
    const points: CityPoint[] = [
      [source.x, source.z + source.depth / 2], [source.x, source.aisle], [from.x, source.aisle],
      ...middle, [to.x, target.aisle], [target.x, target.aisle], [target.x, target.z + target.depth / 2],
    ];
    const ratio = source.rowCount !== null && target.rowCount !== null && target.rowCount > 0
      ? source.rowCount / target.rowCount : null;
    roads.push({ id: `${link.constraintId || 'fk'}:${index}`, source: source.id, target: target.id,
      points: simplify(points), width: ratio === null ? 0.12 : 0.12 + Math.min(0.24, Math.log1p(ratio) * 0.055),
      crossDistrict, inferred: link.kind === 'inferred by naming', ratio });
  });
  return { width, depth, maxHeight: Math.max(0, ...buildings.map(b => b.height)), districts, buildings, roads, basis };
}
