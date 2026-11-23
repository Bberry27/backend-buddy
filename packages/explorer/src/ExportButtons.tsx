import React, { useState } from 'react';
import { Download, FileText, Image } from 'lucide-react';
import './ExportButtons.css';

export type ExportFormat = 'svg' | 'png' | 'csv' | 'html';

const FORMAT_LABEL: Record<ExportFormat, string> = { svg: 'SVG', png: 'PNG', csv: 'CSV', html: 'Report' };
const FORMAT_ICON: Record<ExportFormat, typeof Download> = { svg: Download, png: Image, csv: Download, html: FileText };

/**
 * The export controls a view shows (feature F19). Each button runs its export only when clicked;
 * a failure is shown inline rather than swallowed, and nothing is sent anywhere.
 */
export default function ExportButtons({ subject, formats, onExport, disabled }: {
  /** What is exported, for the accessible names: "Arc Diagram", "Column Table". */
  subject: string;
  formats: readonly ExportFormat[];
  onExport: (format: ExportFormat) => void | Promise<void>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState('');
  const run = async (format: ExportFormat) => {
    setBusy(format); setError('');
    try { await onExport(format); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Export failed.'); } finally { setBusy(null); }
  };
  return <span className="bb-export" role="group" aria-label={`Export ${subject}`}>
    {formats.map(format => {
      const Icon = FORMAT_ICON[format];
      const name = format === 'html' ? `Export ${subject} issue report (HTML)` : `Export ${subject} as ${FORMAT_LABEL[format]}`;
      return <button key={format} type="button" className="bb-export-button" title={name} aria-label={name}
        disabled={disabled || busy !== null} onClick={() => { void run(format); }}>
        <Icon size={15} aria-hidden="true" /><span>{FORMAT_LABEL[format]}</span>
      </button>;
    })}
    {error && <span className="bb-export-error" role="alert">{error}</span>}
  </span>;
}
