import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import type { PreviewBounds, RenderJob } from '@shared/types';
import { formatMilliseconds, formatNumber, formatSeconds, pluralize } from '@shared/format';
import { DEFAULT_FPS } from '@shared/presets';
import { getBridge } from '../lib/api';
import { localizedErrorMessage, useAppActions, useAppState, useLanguage, useT } from '../lib/store';
import { Spinner } from './ui';

/**
 * The video stage.
 *
 * The page itself is a `WebContentsView` owned by the main process. This
 * component measures the stage surface in window coordinates and tells main
 * where to place and how much to scale the live surface. The page is laid out at
 * the export geometry, so the preview and the encoded frame show the same thing.
 *
 * When the stage is scrolled out of view, or a render owns the compositor, the
 * surface is hidden and the same dark well shows the render's real progress.
 */
export function PreviewStage({ activeJob }: { activeJob: RenderJob | null }): ReactNode {
  const { project, preview, draft, settings } = useAppState();
  const { reloadPreview, cancelRender, setPreviewVisible } = useAppActions();
  const t = useT();
  const language = useLanguage();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [fullyVisible, setFullyVisible] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const lastSent = useRef('');
  const visibleRef = useRef(false);

  const width = draft?.width ?? 1920;
  const height = draft?.height ?? 1080;
  const ratio = width / Math.max(1, height);

  const surfaceStyle = {
    '--stage-aspect': `${width} / ${height}`,
    '--stage-ratio': String(ratio),
  } as CSSProperties;

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return undefined;
    let frame = 0;

    const report = (): void => {
      frame = 0;
      const rect = surface.getBoundingClientRect();
      const scroller = surface.closest('.sheet__scroll');
      const viewport = scroller ? scroller.getBoundingClientRect() : null;
      const withinViewport =
        rect.width > 24 &&
        rect.height > 24 &&
        rect.top >= (viewport?.top ?? 0) - 1 &&
        rect.bottom <= (viewport?.bottom ?? window.innerHeight) + 1 &&
        rect.left >= -1 &&
        rect.right <= window.innerWidth + 1;
      setFullyVisible(withinViewport);

      const scale = rect.width / Math.max(1, width);
      const bounds: PreviewBounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scale: Math.max(0.01, Math.min(10, scale)),
      };
      const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${bounds.scale}`;
      if (key === lastSent.current) return;
      lastSent.current = key;
      void getBridge()
        .preview.setBounds(bounds)
        .catch(() => undefined);
    };

    const schedule = (): void => {
      if (frame) return;
      frame = window.requestAnimationFrame(report);
    };

    report();
    const observer = new ResizeObserver(schedule);
    observer.observe(surface);
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      if (visibleRef.current) {
        visibleRef.current = false;
        setPreviewVisible(false);
      }
    };
  }, [setPreviewVisible, width, height]);

  const previewBelongs = Boolean(project) && preview.projectId === project?.id;
  const previewReady = previewBelongs && !preview.loading && !preview.error && Boolean(preview.url);
  const rendering = activeJob?.status === 'running';
  const showLive = previewReady && !rendering && fullyVisible;

  useEffect(() => {
    if (visibleRef.current === showLive) return undefined;
    visibleRef.current = showLive;
    setPreviewVisible(showLive);
    return () => {
      if (visibleRef.current) {
        visibleRef.current = false;
        setPreviewVisible(false);
      }
    };
  }, [showLive, setPreviewVisible]);

  useEffect(() => {
    if (!rendering) setCancelling(false);
  }, [rendering]);

  const percent =
    activeJob?.progress.percent === null || activeJob?.progress.percent === undefined
      ? null
      : Math.max(0, Math.min(100, Math.round(activeJob.progress.percent)));

  return (
    <div className="stage-wrap">
      <div className="stage">
        <div className="stage__surface" ref={surfaceRef} style={surfaceStyle} aria-hidden={showLive}>
          <div className="stage__placeholder">
            {rendering && activeJob ? (
              <div className="stage__progress">
                <div className="stage__progress-head">
                  <span className="phase-dot phase-dot--pulse" aria-hidden="true" />
                  <span>{activeJob.progress.message}</span>
                </div>
                <div className="stage__progress-pct mono tnum">
                  {percent === null ? '—' : percent}
                  <small>%</small>
                </div>
                <div className="stage__progress-track" aria-hidden="true">
                  <span
                    className={percent === null ? 'stage__progress-fill stage__progress-fill--idle' : 'stage__progress-fill'}
                    style={percent === null ? undefined : { width: `${percent}%` }}
                  />
                </div>
                <div className="stage__progress-meta">
                  <span className="tnum">
                    {activeJob.progress.frames
                      ? `${formatNumber(activeJob.progress.frames.captured, 0, language)} / ${formatNumber(activeJob.progress.frames.target, 0, language)} frames`
                      : formatMilliseconds(activeJob.progress.elapsedMs)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="tnum">{formatMilliseconds(activeJob.progress.elapsedMs)}</span>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="btn btn--quiet stage__cancel"
                    onClick={() => {
                      setCancelling(true);
                      void cancelRender(activeJob.id);
                    }}
                    disabled={cancelling}
                  >
                    {cancelling ? t('ui.action.cancelling') : t('ui.action.cancel')}
                  </button>
                </div>
              </div>
            ) : preview.error ? (
              <div className="stage__message">
                <AlertTriangle size={20} aria-hidden="true" />
                <strong>{t('ui.stage.previewFailed')}</strong>
                <p>{localizedErrorMessage(preview.error, t)}</p>
                <button type="button" className="btn btn--quiet" onClick={() => void reloadPreview()}>
                  <RotateCw size={14} aria-hidden="true" />
                  {t('ui.action.retry')}
                </button>
              </div>
            ) : preview.loading || !previewReady ? (
              <div className="stage__message">
                <Spinner size={18} />
                <strong>{t('ui.stage.loading')}</strong>
                <p>{t('ui.stage.loadingDetail')}</p>
              </div>
            ) : !fullyVisible ? (
              <div className="stage__message">
                <strong>{t('ui.stage.suspended')}</strong>
                <p>{t('ui.stage.suspendedDetail')}</p>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="stage__bar">
        <span className="stage__live" data-live={showLive}>
          <span className="stage__live-dot" aria-hidden="true" />
          {rendering
            ? t('ui.stage.state.rendering')
            : showLive
              ? t('ui.stage.state.live')
              : previewReady
                ? t('ui.stage.state.waiting')
                : t('ui.stage.state.loading')}
        </span>
        <span className="stage__bar-sep" aria-hidden="true">
          ·
        </span>
        <span className="mono tnum">
          {width} × {height}
        </span>
        <span className="stage__bar-sep" aria-hidden="true">
          ·
        </span>
        <span className="tnum">{draft?.fps ?? DEFAULT_FPS} fps</span>
        <span className="stage__bar-sep" aria-hidden="true">
          ·
        </span>
        <span className="tnum">
          {draft
            ? draft.duration.mode === 'manual'
              ? formatSeconds(draft.duration.seconds, language)
              : t('ui.duration.upToValue', { time: formatSeconds(draft.duration.maxSeconds, language) })
            : '—'}
        </span>
        {settings?.allowRemoteResources === false ? (
          <>
            <span className="stage__bar-sep" aria-hidden="true">
              ·
            </span>
            <span className="chip">{t('ui.stage.remoteOff')}</span>
          </>
        ) : null}
        <span className="spacer" />
        <span
          className="stage__source mono"
          title={project ? t('ui.files.titleMany', { count: project.htmlFileCount + project.assetCount }) : undefined}
        >
          {project
            ? `${formatNumber(project.htmlFileCount + project.assetCount, 0, language)} ${pluralize(project.htmlFileCount + project.assetCount, t('ui.files.one'), t('ui.files.many'))}`
            : null}
        </span>
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => void reloadPreview()}
          disabled={rendering || !previewReady}
          title={t('ui.stage.reloadTitle')}
        >
          <RotateCw size={14} aria-hidden="true" />
          {t('ui.action.reload')}
        </button>
      </div>
    </div>
  );
}
