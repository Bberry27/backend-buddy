/**
 * Image export for the diagram views (feature F19): SVG and PNG of what a view currently shows,
 * framed with the snapshot's provenance and a legend so the file explains itself away from the
 * explorer.
 *
 * Everything runs in the page and only on an explicit click. Nothing is uploaded: the file is a
 * Blob handed to an anchor with a `download` attribute. The offline artifact's policy allows
 * images only from `data:` URLs, so rasterising goes SVG text -> `data:image/svg+xml` -> <img> ->
 * <canvas> -> PNG Blob, never through a `blob:` image source.
 *
 * `buildExportSvg` is pure string assembly and unit-tested; the DOM helpers below it are covered
 * by the artifact-level browser test (`export-browser.test.mjs`).
 */
import { escapeHtml } from './export-logic';

export interface ExportLegendItem {
  label: string;
  color: string;
  /** Draw the swatch as a dashed line, for inferred or cyclic marks that are dashed in the view. */
  dashed?: boolean;
}

export interface ExportFrame {
  title: string;
  /** Provenance and scope, one line each, drawn under the title. */
  lines: readonly string[];
  legend?: readonly ExportLegendItem[];
  /** Caveats and evidence notes, drawn under the diagram and wrapped to its width. */
  notes?: readonly string[];
  colors: { background: string; ink: string; muted: string; line: string };
  fontFamily?: string;
}

export interface ExportBody {
  /** A complete `<svg>` element as markup, already carrying its own width, height and viewBox. */
  markup: string;
  width: number;
  height: number;
}

const LINE = 17, PAD = 16, CHAR = 6.4;

/** Greedy word wrap by an average glyph width; long tokens are split rather than overflowing. */
export function wrapText(value: string, width: number): string[] {
  const max = Math.max(20, Math.floor(width / CHAR));
  const lines: string[] = [];
  let line = '';
  for (const word of value.split(/\s+/).filter(Boolean)) {
    for (let rest = word; rest.length;) {
      const piece = rest.slice(0, max); rest = rest.slice(max);
      const next = line ? `${line} ${piece}` : piece;
      if (next.length > max && line) { lines.push(line); line = piece; } else line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** The exported document: a header with title, provenance and legend, the diagram, then notes. */
export function buildExportSvg(frame: ExportFrame, body: ExportBody): { svg: string; width: number; height: number } {
  const e = escapeHtml;
  const width = Math.ceil(Math.max(body.width, 760));
  const textWidth = width - PAD * 2;
  const font = frame.fontFamily || "'Segoe UI', Arial, sans-serif";
  const parts: string[] = [];
  let y = PAD + 16;
  parts.push(`<text x="${PAD}" y="${y}" font-size="16" font-weight="600" fill="${e(frame.colors.ink)}">${e(frame.title)}</text>`);
  y += 6;
  for (const line of frame.lines) for (const wrapped of wrapText(line, textWidth)) {
    y += LINE;
    parts.push(`<text x="${PAD}" y="${y}" font-size="11" fill="${e(frame.colors.muted)}">${e(wrapped)}</text>`);
  }
  if (frame.legend?.length) {
    y += LINE + 4;
    let x = PAD;
    for (const item of frame.legend) {
      const itemWidth = 22 + item.label.length * CHAR + 18;
      if (x + itemWidth > width - PAD && x > PAD) { x = PAD; y += LINE + 2; }
      parts.push(item.dashed
        ? `<line x1="${x}" y1="${y - 4}" x2="${x + 16}" y2="${y - 4}" stroke="${e(item.color)}" stroke-width="2.5" stroke-dasharray="4 3"/>`
        : `<rect x="${x}" y="${y - 10}" width="12" height="12" rx="2" fill="${e(item.color)}"/>`);
      parts.push(`<text x="${x + 22}" y="${y}" font-size="11" fill="${e(frame.colors.ink)}">${e(item.label)}</text>`);
      x += itemWidth;
    }
  }
  y += 12;
  parts.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${e(frame.colors.line)}"/>`);
  const top = y + 1;
  parts.push(`<g transform="translate(${Math.round((width - body.width) / 2)},${top})">${body.markup}</g>`);
  y = top + body.height + 6;
  if (frame.notes?.length) {
    parts.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${e(frame.colors.line)}"/>`);
    y += 4;
    for (const note of frame.notes) for (const wrapped of wrapText(note, textWidth)) {
      y += LINE;
      parts.push(`<text x="${PAD}" y="${y}" font-size="11" fill="${e(frame.colors.muted)}">${e(wrapped)}</text>`);
    }
  }
  const height = Math.ceil(y + PAD);
  const description = [frame.title, ...frame.lines, ...(frame.notes ?? [])].join('\n');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${e(font)}">`
    + `<title>${e(frame.title)}</title><desc>${e(description)}</desc>`
    + `<rect width="100%" height="100%" fill="${e(frame.colors.background)}"/>${parts.join('')}</svg>`;
  return { svg, width, height };
}

// ---------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------

/** Presentation properties resolved from the live view, so classes and custom properties survive. */
const STYLE_PROPERTIES = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
  'visibility', 'display', 'paint-order'];

/**
 * Serialise a live `<svg>` with every element's computed presentation inlined, sized to
 * `width` x `height` (and `viewBox` when given) rather than to its on-screen zoom.
 */
export function inlineSvg(source: SVGSVGElement, width: number, height: number, viewBox?: string): string {
  const clone = source.cloneNode(true) as SVGSVGElement;
  const originals = [source, ...source.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  copies.forEach((node, index) => {
    const computed = getComputedStyle(originals[index]);
    node.setAttribute('style', STYLE_PROPERTIES.map(property => {
      const value = computed.getPropertyValue(property);
      return value ? `${property}:${value}` : '';
    }).filter(Boolean).join(';'));
    for (const attribute of ['tabindex', 'role', 'aria-pressed']) node.removeAttribute(attribute);
  });
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(Math.ceil(width)));
  clone.setAttribute('height', String(Math.ceil(height)));
  if (viewBox) clone.setAttribute('viewBox', viewBox);
  return new XMLSerializer().serializeToString(clone);
}

/** The host page's theme colours at the moment of export, from its custom properties. */
export function exportColors(element: Element, fallback: { bg: string; ink: string; muted: string; line: string }) {
  const style = getComputedStyle(element);
  const read = (name: string, value: string) => style.getPropertyValue(name).trim() || value;
  return { background: read('--bg', fallback.bg), ink: read('--ink', fallback.ink), muted: read('--muted', fallback.muted), line: read('--line', fallback.line) };
}

/** Hand a Blob to the browser as a file download. Only ever called from a click handler. */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try { anchor.click(); } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function downloadText(content: string, fileName: string, type: string) {
  downloadBlob(new Blob([content], { type }), fileName);
}

/** Largest PNG edge. Browsers cap canvas size; past this the export would fail or come back blank. */
const MAX_EDGE = 8192;
const MAX_PIXELS = 40_000_000;

export function pngScale(width: number, height: number, preferred = 2) {
  return Math.max(0.1, Math.min(preferred, MAX_EDGE / width, MAX_EDGE / height, Math.sqrt(MAX_PIXELS / (width * height))));
}

/** Rasterise SVG text to a PNG Blob through a `data:` image, which the artifact policy allows. */
export async function svgToPng(svg: string, width: number, height: number, preferredScale = 2): Promise<Blob> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('The diagram could not be rasterised to PNG.'));
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const scale = pngScale(width, height, preferredScale);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable, so PNG export cannot run.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed.')), 'image/png'));
}

/** Build the framed document, then download it as SVG or PNG. */
export async function exportDiagram(format: 'svg' | 'png', frame: ExportFrame, body: ExportBody, fileStem: string) {
  const built = buildExportSvg(frame, body);
  if (format === 'svg') downloadText(built.svg, `${fileStem}.svg`, 'image/svg+xml');
  else downloadBlob(await svgToPng(built.svg, built.width, built.height), `${fileStem}.png`);
}
