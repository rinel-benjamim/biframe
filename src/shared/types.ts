/**
 * Domain types shared by the Electron main process, the render engine and the
 * React interface. Nothing in this module may import Electron, React or Node
 * built-ins: it is the neutral contract between all three.
 */

export type ProjectKind = 'html' | 'zip';

export interface ProjectInfo {
  id: string;
  name: string;
  kind: ProjectKind;
  /** Absolute path of the HTML entry file inside the extracted project. */
  entryPath: string;
  /** Absolute path of the project root (temp directory for imported projects). */
  rootPath: string;
  /** Path of the file the user actually imported. */
  sourcePath: string;
  sizeBytes: number;
  importedAt: number;
  htmlFileCount: number;
  assetCount: number;
  /** Remote http(s) URLs referenced by the HTML (fonts, images, scripts). */
  remoteResourceHosts: string[];
  warnings: Diagnostic[];
}

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export type DiagnosticCode =
  | 'REMOTE_RESOURCES'
  | 'MISSING_RESOURCE'
  | 'FONT_FALLBACK'
  | 'SCRIPT_ERROR'
  | 'CONSOLE_ERROR'
  | 'PAGE_WARNING'
  | 'NAVIGATION_BLOCKED'
  | 'WINDOW_OPEN_BLOCKED'
  | 'DIALOG_DISMISSED'
  | 'SLOW_RESOURCE'
  | 'HTML_ONLY_PROJECT'
  | 'ZIP_ENTRY_SKIPPED'
  | 'PAGE_NEVER_IDLE'
  | 'PAGE_LOAD_FAILED'
  | 'FRAME_CAPTURE_FAILED'
  | 'BLANK_FRAMES'
  | 'STATIC_FRAMES'
  | 'OUTPUT_TRUNCATED'
  | 'AUDIO_UNSUPPORTED'
  | 'CAPTURE_RATE_LOW'
  | 'REMOTE_RESOURCE_BLOCKED'
  | 'PRIVATE_NETWORK_BLOCKED'
  | 'PERMISSION_BLOCKED'
  | 'DOWNLOAD_BLOCKED'
  | 'WEBVIEW_BLOCKED'
  | 'RENDER_PROCESS_GONE'
  | 'PAGE_UNRESPONSIVE';

export interface Diagnostic {
  id: string;
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  /** Short, user-facing sentence. */
  message: string;
  /** Technical detail for the log, never a stack trace in the UI. */
  detail?: string;
  /** Resource related to the diagnostic, when applicable. */
  url?: string;
  /** Moment the diagnostic was produced (epoch ms). */
  at: number;
}

export type AspectRatioId = '16:9' | '9:16' | '1:1' | '4:5' | 'custom';

export interface ResolutionPreset {
  id: string;
  label: string;
  detail: string;
  width: number;
  height: number;
  aspect: AspectRatioId;
  /** Wide test of the engine; 2160p is offered but flagged as demanding. */
  demanding?: boolean;
}

export type QualityPresetId = 'compact' | 'balanced' | 'high';

export interface QualityPreset {
  id: QualityPresetId;
  label: string;
  description: string;
  crf: number;
  x264Preset: string;
}

export interface ManualDuration {
  mode: 'manual';
  seconds: number;
}

export interface AutoDuration {
  mode: 'auto';
  /** Hard ceiling; capture stops here even when the page never signals. */
  maxSeconds: number;
}

export type DurationSetting = ManualDuration | AutoDuration;

export type EncoderId = 'x264';

export interface RenderSettings {
  fileName: string;
  outputDir: string;
  width: number;
  height: number;
  fps: number;
  duration: DurationSetting;
  quality: QualityPresetId;
  container: 'mp4';
  encoder: EncoderId;
  /** How the project viewport is fitted into the output frame. */
  fit: 'contain';
}

export type RenderPhase =
  | 'queued'
  | 'preparing'
  | 'launching'
  | 'loading'
  | 'capturing'
  | 'resampling'
  | 'encoding'
  | 'validating'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface FrameProgress {
  captured: number;
  target: number;
}

export interface RenderProgress {
  jobId: string;
  phase: RenderPhase;
  /** User-facing status sentence (Portuguese). */
  message: string;
  /** Real progress when the phase has a known total, otherwise null. */
  percent: number | null;
  elapsedMs: number;
  frames?: FrameProgress;
  /** Diagnostics produced so far during this render. */
  diagnostics: Diagnostic[];
}

export type RenderStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface ValidationCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface ValidationReport {
  ok: boolean;
  checks: ValidationCheck[];
}

export interface VideoMetadata {
  codec: string;
  profile?: string;
  width: number;
  height: number;
  fps: number;
  pixFmt: string;
  frames: number | null;
  durationSeconds: number;
  bitrate: number;
}

export interface RenderResult {
  jobId: string;
  outputPath: string;
  fileName: string;
  sizeBytes: number;
  metadata: VideoMetadata;
  validation: ValidationReport;
  diagnostics: Diagnostic[];
  /** JPEG stills extracted from the produced video (absolute paths). */
  posterFrames: string[];
  startedAt: number;
  finishedAt: number;
}

export interface SerializedError {
  code: string;
  title: string;
  message: string;
  detail?: string;
  recoverable: boolean;
}

export interface RenderJob {
  id: string;
  projectId: string;
  projectName: string;
  settings: RenderSettings;
  status: RenderStatus;
  progress: RenderProgress;
  result?: RenderResult;
  error?: SerializedError;
  startedAt: number;
  finishedAt?: number;
}

export interface EngineBinaryStatus {
  kind: 'ffmpeg' | 'ffprobe';
  available: boolean;
  path?: string;
  version?: string;
  source?: 'bundled' | 'system';
  error?: string;
}

export interface EngineStatus {
  ready: boolean;
  chromium: {
    version: string;
    available: true;
  };
  ffmpeg: EngineBinaryStatus;
  ffprobe: EngineBinaryStatus;
  tempDir: {
    path: string;
    writable: boolean;
    freeBytes: number | null;
  };
  /** `process.platform` of the process that checked the engine. */
  platform: string;
  appVersion: string;
  checkedAt: number;
}

export interface ResourceLimits {
  maxProjectBytes: number;
  maxZipEntries: number;
  maxDurationSeconds: number;
  maxConcurrentJobs: number;
  pageLoadTimeoutMs: number;
  browserLaunchTimeoutMs: number;
}

/** The theme the interface is actually wearing, after resolving `system`. */
export type EffectiveTheme = 'light' | 'dark';

export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  defaultOutputDir: string;
  allowRemoteResources: boolean;
  openResultAfterRender: boolean;
  keepTempFiles: boolean;
  limits: ResourceLimits;
}

export interface HistoryEntry {
  id: string;
  projectName: string;
  fileName: string;
  outputPath: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  status: RenderStatus;
  startedAt: number;
  finishedAt?: number;
  error?: SerializedError;
}

export interface ProjectLoadRequest {
  path: string;
}

export interface PreviewState {
  loading: boolean;
  url: string | null;
  projectId: string | null;
  lastReloadAt: number | null;
  diagnostics: Diagnostic[];
  error: SerializedError | null;
}

/**
 * Where the preview surface must sit, in window content coordinates (device
 * independent pixels, the same units the interface uses). `scale` is how many
 * screen pixels one layout pixel occupies: the page is laid out at the export
 * geometry and scaled by this factor, so the preview matches the encoded video.
 * `width`/`height` may be smaller than the stage when the stage is partly
 * scrolled out of view — the surface is cropped, the layout is not.
 */
export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
}
