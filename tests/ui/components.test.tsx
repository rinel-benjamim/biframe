import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CheckList,
  DiagnosticList,
  DiagnosticSummary,
  Notice,
  ProgressBlock,
  StatusChip,
  Switch,
} from '@renderer/components/ui';
import type { Diagnostic, RenderProgress, ValidationCheck } from '@shared/types';
import type { AppNotice } from '@renderer/lib/store';

const checks: ValidationCheck[] = [
  { id: 'a', label: 'Contentor MP4', status: 'pass', detail: 'mov,mp4' },
  { id: 'b', label: 'Áudio', status: 'warn', detail: '1 faixa' },
  { id: 'c', label: 'Codec', status: 'fail', detail: 'vp9' },
];

const diagnostics: Diagnostic[] = [
  { id: '1', code: 'REMOTE_RESOURCES', severity: 'info', message: 'Recursos externos', at: 2 },
  {
    id: '2',
    code: 'MISSING_RESOURCE',
    severity: 'warning',
    message: 'Imagem em falta',
    detail: 'net::ERR_FAILED',
    url: 'https://x.test/a.png',
    at: 3,
  },
  { id: '3', code: 'SCRIPT_ERROR', severity: 'error', message: 'Erro de JavaScript', at: 1 },
];

describe('Notice', () => {
  const notice: AppNotice = {
    id: 1,
    kind: 'error',
    title: 'A exportação não terminou',
    message: 'Pasta inválida',
    detail: 'C:\\inexistente',
  };

  it('renders title, message and detail with an alert role for errors', () => {
    render(<Notice notice={notice} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-kind', 'error');
    expect(alert).toHaveTextContent('A exportação não terminou');
    expect(alert).toHaveTextContent('Pasta inválida');
    expect(alert).toHaveTextContent('C:\\inexistente');
  });

  it('calls onDismiss from the close button', async () => {
    const onDismiss = vi.fn();
    render(<Notice notice={notice} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fechar aviso' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('uses a status role for informational notices', () => {
    render(<Notice notice={{ id: 2, kind: 'info', title: 'Aviso' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Aviso');
  });
});

describe('CheckList', () => {
  it('renders one labelled mark and detail per check', () => {
    render(<CheckList checks={checks} />);
    expect(screen.getByLabelText('Passou')).toHaveTextContent('✓');
    expect(screen.getByLabelText('Aviso')).toHaveTextContent('!');
    expect(screen.getByLabelText('Falhou')).toHaveTextContent('×');
    expect(screen.getByText('Contentor MP4')).toBeInTheDocument();
    expect(screen.getByText('vp9')).toBeInTheDocument();
    const rows = document.querySelectorAll('.check');
    expect(rows[2]).toHaveAttribute('data-status', 'fail');
  });
});

describe('DiagnosticList', () => {
  it('sorts errors before warnings and information', () => {
    render(<DiagnosticList diagnostics={diagnostics} />);
    const rows = Array.from(document.querySelectorAll('.diag__row'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Erro de JavaScript');
    expect(rows[1]).toHaveTextContent('Imagem em falta');
    expect(rows[2]).toHaveTextContent('Recursos externos');
    expect(screen.getByText('SCRIPT_ERROR')).toBeInTheDocument();
    expect(screen.getByText('https://x.test/a.png')).toBeInTheDocument();
  });

  it('shows the empty message when there is nothing to report', () => {
    render(<DiagnosticList diagnostics={[]} emptyMessage="Tudo limpo" />);
    expect(screen.getByText('Tudo limpo')).toBeInTheDocument();
  });
});

describe('DiagnosticSummary', () => {
  it('summarises clean, warning and error states', () => {
    const { rerender } = render(<DiagnosticSummary diagnostics={[]} />);
    expect(screen.getByText('Sem avisos')).toBeInTheDocument();
    rerender(<DiagnosticSummary diagnostics={[diagnostics[1] as Diagnostic]} />);
    expect(screen.getByText('1 aviso')).toBeInTheDocument();
    rerender(<DiagnosticSummary diagnostics={[diagnostics[2] as Diagnostic, diagnostics[0] as Diagnostic]} />);
    expect(screen.getByText('1 erro')).toBeInTheDocument();
    rerender(<DiagnosticSummary diagnostics={[diagnostics[0] as Diagnostic]} />);
    expect(screen.getByText('1 nota')).toBeInTheDocument();
  });
});

describe('ProgressBlock', () => {
  const progress: RenderProgress = {
    jobId: 'job',
    phase: 'encoding',
    message: 'A codificar 21 de 50 frames',
    percent: 42,
    elapsedMs: 65_000,
    frames: { captured: 21, target: 50 },
    diagnostics: [],
  };

  it('exposes a real progressbar with frames and elapsed time', () => {
    render(<ProgressBlock progress={progress} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuetext', '42%');
    expect(screen.getByText(/21 \/ 50 frames/)).toBeInTheDocument();
    expect(screen.getByText('01:05')).toBeInTheDocument();
  });

  it('renders an indeterminate bar and calls onCancel', async () => {
    const onCancel = vi.fn();
    render(<ProgressBlock progress={{ ...progress, percent: null }} onCancel={onCancel} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a cancelling label and disables the button', () => {
    render(<ProgressBlock progress={progress} onCancel={() => undefined} cancelling />);
    expect(screen.getByRole('button', { name: 'A cancelar…' })).toBeDisabled();
  });
});

describe('Switch', () => {
  it('reflects and toggles its checked state', async () => {
    let value = false;
    const { rerender } = render(
      <Switch
        id="remote"
        checked={value}
        onChange={(next) => {
          value = next;
        }}
        label="Recursos externos"
        description="Permitir pedidos a outros domínios"
      />,
    );
    const checkbox = screen.getByRole('checkbox', { name: /Recursos externos/ });
    expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    expect(value).toBe(true);
    rerender(
      <Switch id="remote" checked={value} onChange={() => undefined} label="Recursos externos" />,
    );
    expect(checkbox).toBeChecked();
  });
});

describe('StatusChip', () => {
  it('labels each engine state with a tone', () => {
    const { rerender } = render(<StatusChip status="ready" />);
    expect(screen.getByText('Motor pronto').closest('.chip')).toHaveAttribute('data-tone', 'ok');
    rerender(<StatusChip status="checking" />);
    expect(screen.getByText('A verificar…').closest('.chip')).toHaveAttribute('data-tone', 'muted');
    rerender(<StatusChip status="broken" />);
    expect(screen.getByText('Motor incompleto').closest('.chip')).toHaveAttribute('data-tone', 'bad');
  });
});
