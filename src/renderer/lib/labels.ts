import type {
  Diagnostic,
  DiagnosticSeverity,
  ProjectInfo,
  RenderStatus,
  ResolutionPreset,
} from '@shared/types';
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

export const VIEW_LABELS: Record<string, string> = {
  studio: 'Estúdio',
  result: 'Resultado',
  history: 'Histórico',
  settings: 'Definições',
};

export const STATUS_LABELS: Record<RenderStatus, string> = {
  running: 'A renderizar',
  completed: 'Concluído',
  cancelled: 'Cancelado',
  failed: 'Falhou',
};

export const KIND_LABELS: Record<ProjectInfo['kind'], string> = {
  html: 'HTML',
  zip: 'ZIP',
};

export const SEVERITY_LABELS: Record<DiagnosticSeverity, string> = {
  info: 'Informação',
  warning: 'Aviso',
  error: 'Erro',
};

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
