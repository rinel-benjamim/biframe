import type {
  Diagnostic,
  DiagnosticSeverity,
  ProjectInfo,
  RenderStatus,
  ResolutionPreset,
} from '@shared/types';
import type { MessageKey, Translator } from '@shared/i18n';
import { RESOLUTION_PRESETS } from '@shared/presets';

export const MEDIA_SCHEME = 'biframe-media';

/** URL of a still produced by the render (served by the main process). */
export function posterUrl(jobId: string, index: number): string {
  return `${MEDIA_SCHEME}://poster/${encodeURIComponent(jobId)}/${index}`;
}

/** URL of the encoded MP4, with HTTP range support for seeking. */
export function outputUrl(id: string): string {
  return `${MEDIA_SCHEME}://output/${encodeURIComponent(id)}`;
}

const VIEW_LABELS: Record<string, MessageKey> = {
  studio: 'ui.view.studio',
  result: 'ui.view.result',
  history: 'ui.view.history',
  settings: 'ui.view.settings',
};

/** Name of a screen; unknown views fall back to the studio, as before. */
export function viewLabel(view: string, t: Translator): string {
  return t(VIEW_LABELS[view] ?? 'ui.view.studio');
}

const STATUS_LABELS: Record<RenderStatus, MessageKey> = {
  running: 'ui.status.running',
  completed: 'ui.status.completed',
  cancelled: 'ui.status.cancelled',
  failed: 'ui.status.failed',
};

export function statusLabel(status: RenderStatus, t: Translator): string {
  return t(STATUS_LABELS[status]);
}

export const KIND_LABELS: Record<ProjectInfo['kind'], string> = {
  html: 'HTML',
  zip: 'ZIP',
};

const SEVERITY_LABELS: Record<DiagnosticSeverity, MessageKey> = {
  info: 'ui.severity.info',
  warning: 'ui.severity.warning',
  error: 'ui.severity.error',
};

export function severityLabel(severity: DiagnosticSeverity, t: Translator): string {
  return t(SEVERITY_LABELS[severity]);
}

/** `preset.label` arrives already localized from `localizedResolutionPresets`. */
export function resolutionLabel(preset: ResolutionPreset): string {
  return `${preset.label} · ${preset.width} × ${preset.height}`;
}

export function findPresetById(id: string): ResolutionPreset | null {
  return RESOLUTION_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function projectEntryName(project: ProjectInfo): string {
  const normalized = project.entryPath.replaceAll('\\', '/');
  const root = project.rootPath.replaceAll('\\', '/');
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized.split('/').pop() ?? project.name;
}

export function countBySeverity(diagnostics: Diagnostic[]): Record<DiagnosticSeverity, number> {
  const counts: Record<DiagnosticSeverity, number> = { info: 0, warning: 0, error: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
  return counts;
}
