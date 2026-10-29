import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  X,
} from 'lucide-react';
import type { Diagnostic, RenderProgress, ValidationCheck } from '@shared/types';
import { formatMilliseconds, formatNumber, pluralize } from '@shared/format';
import { useLanguage, useT, type AppNotice } from '../lib/store';

export function Mark({ size = 20, className }: { size?: number; className?: string }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect x="2.75" y="2.75" width="18.5" height="18.5" rx="5.1" stroke="currentColor" strokeWidth="1.55" />
      <path d="M10.05 8.25 16 12l-5.95 3.75V8.25Z" fill="var(--accent)" />
    </svg>
  );
}

export function Spinner({ size = 16, label }: { size?: number; label?: string }): ReactNode {
  return (
    <span className="spinner-inline" role={label ? 'status' : undefined}>
      <Loader2 size={size} className="icon-spin" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

const noticeIcons = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertTriangle,
} as const;

export function Notice({
  notice,
  onDismiss,
}: {
  notice: AppNotice;
  onDismiss?: () => void;
}): ReactNode {
  const t = useT();
  const Icon = noticeIcons[notice.kind];
  return (
    <div className="notice" data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <Icon size={17} aria-hidden="true" className={`notice__icon notice__icon--${notice.kind}`} />
      <div className="notice__body">
        <div className="notice__title">{notice.title}</div>
        {notice.message ? <div className="notice__message">{notice.message}</div> : null}
        {notice.detail ? <div className="notice__detail">{notice.detail}</div> : null}
        {notice.action ? (
          <div className="notice__actions">
            <button type="button" className="btn" onClick={notice.action.run}>
              {notice.action.label}
            </button>
          </div>
        ) : null}
      </div>
      {onDismiss ? (
        <button type="button" className="btn btn--quiet btn--icon" onClick={onDismiss} aria-label={t('ui.notice.closeAria')}>
          <X size={15} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function Switch({
  id,
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}): ReactNode {
  return (
    <label className="toggle-row" htmlFor={id}>
      <span className="toggle-row__text">
        <strong>{label}</strong>
        {description ? <span>{description}</span> : null}
      </span>
      <span className="switch">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span className="switch__track" aria-hidden="true" />
      </span>
    </label>
  );
}

export function ProgressBlock({
  progress,
  onCancel,
  cancelling,
}: {
  progress: RenderProgress;
  onCancel?: () => void;
  cancelling?: boolean;
}): ReactNode {
  const t = useT();
  const language = useLanguage();
  const percent = progress.percent === null ? null : Math.max(0, Math.min(100, Math.round(progress.percent)));
  const frames = progress.frames;
  return (
    <div className="progress">
      <div className="progress__line">
        <span className={`phase-dot ${progress.phase === 'completed' ? '' : 'phase-dot--pulse'}`} aria-hidden="true" />
        <span className="progress__phase">{progress.message}</span>
        {percent !== null ? <span className="progress__pct tnum mono">{percent}%</span> : null}
      </div>
      <div
        className="progress__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? progress.message : `${percent}%`}
      >
        {percent === null ? (
          <div className="progress__fill progress__fill--idle" />
        ) : (
          <div className="progress__fill" style={{ width: `${percent}%` }} />
        )}
      </div>
      <div className="progress__meta">
        {frames ? (
          <span className="tnum">
            {formatNumber(frames.captured, 0, language)} / {formatNumber(frames.target, 0, language)} frames
          </span>
        ) : (
          <span className="tnum">{formatMilliseconds(progress.elapsedMs)}</span>
        )}
        {frames ? (
          <>
            <span className="progress__sep" aria-hidden="true">
              ·
            </span>
            <span className="tnum">{formatMilliseconds(progress.elapsedMs)}</span>
          </>
        ) : null}
        <span className="spacer" />
        {onCancel ? (
          <button type="button" className="btn btn--quiet btn--danger" onClick={onCancel} disabled={cancelling}>
            {cancelling ? t('ui.action.cancelling') : t('ui.action.cancel')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

const checkMarks: Record<ValidationCheck['status'], string> = {
  pass: '✓',
  warn: '!',
  fail: '×',
};

export function CheckList({ checks }: { checks: ValidationCheck[] }): ReactNode {
  const t = useT();
  return (
    <div className="checks">
      {checks.map((check) => (
        <div className="check" data-status={check.status} key={check.id}>
          <span
            className="check__mark"
            aria-label={check.status === 'pass' ? t('ui.check.pass') : check.status === 'warn' ? t('ui.check.warn') : t('ui.check.fail')}
          >
            {checkMarks[check.status]}
          </span>
          <span>{check.label}</span>
          <span className="check__detail mono">{check.detail}</span>
        </div>
      ))}
    </div>
  );
}

const severityRank: Record<Diagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };

export function DiagnosticList({
  diagnostics,
  emptyMessage,
}: {
  diagnostics: Diagnostic[];
  emptyMessage?: string;
}): ReactNode {
  const t = useT();
  if (diagnostics.length === 0) {
    return (
      <p className="calm">
        {emptyMessage ?? t('ui.diagnostics.empty')}
      </p>
    );
  }
  const sorted = [...diagnostics].sort((left, right) => {
    const bySeverity = severityRank[left.severity] - severityRank[right.severity];
    return bySeverity !== 0 ? bySeverity : right.at - left.at;
  });
  return (
    <div className="diag">
      {sorted.map((diagnostic) => (
        <div className="diag__row" key={diagnostic.id}>
          <span className="diag__mark" data-severity={diagnostic.severity} aria-hidden="true" />
          <div className="diag__body">
            <div className="diag__message">
              <span>{diagnostic.message}</span>
              <span className="diag__code mono">{diagnostic.code}</span>
            </div>
            {diagnostic.detail ? <div className="diag__detail">{diagnostic.detail}</div> : null}
            {diagnostic.url ? (
              <div className="diag__url mono" title={diagnostic.url}>
                {diagnostic.url}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function DiagnosticSummary({ diagnostics }: { diagnostics: Diagnostic[] }): ReactNode {
  const t = useT();
  const errors = diagnostics.filter((item) => item.severity === 'error').length;
  const warnings = diagnostics.filter((item) => item.severity === 'warning').length;
  if (diagnostics.length === 0) return <span className="chip">{t('ui.diagnostics.none')}</span>;
  if (errors > 0) {
    return (
      <span className="chip chip--error">
        {errors} {pluralize(errors, t('ui.diagnostics.error.one'), t('ui.diagnostics.error.many'))}
      </span>
    );
  }
  if (warnings > 0) {
    return (
      <span className="chip chip--warning">
        {warnings} {pluralize(warnings, t('ui.diagnostics.warning.one'), t('ui.diagnostics.warning.many'))}
      </span>
    );
  }
  return (
    <span className="chip">
      {diagnostics.length} {pluralize(diagnostics.length, t('ui.diagnostics.note.one'), t('ui.diagnostics.note.many'))}
    </span>
  );
}

export function StatusChip({ status }: { status: 'ready' | 'broken' | 'checking' }): ReactNode {
  const t = useT();
  const label =
    status === 'ready'
      ? t('ui.engine.status.ready')
      : status === 'checking'
        ? t('ui.engine.status.checkingShort')
        : t('ui.engine.status.incomplete');
  return (
    <span className="chip" data-tone={status === 'ready' ? 'ok' : status === 'broken' ? 'bad' : 'muted'}>
      <span className="status-dot" data-state={status} aria-hidden="true" />
      {label}
    </span>
  );
}
