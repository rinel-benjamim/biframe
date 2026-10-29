import { useState, type ReactNode } from 'react';
import {
  FolderOpen,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
} from 'lucide-react';
import type { Translator } from '@shared/i18n';
import { formatBytes } from '@shared/format';
import type { AppSettings } from '@shared/types';
import { useAppActions, useAppState, useT } from '../lib/store';
import { Spinner, StatusChip, Switch } from '../components/ui';

function platformLabel(platform: string): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return platform;
}

function binaryLine(
  label: string,
  binary: { available: boolean; version?: string; path?: string; source?: string; error?: string },
  t: Translator,
): ReactNode {
  return (
    <div className="engine-line" data-state={binary.available ? 'ready' : 'broken'}>
      <span className="status-dot" data-state={binary.available ? 'ready' : 'broken'} aria-hidden="true" />
      <div className="engine-line__body">
        <div className="engine-line__title">
          {label}
          <span className="engine-line__value mono">
            {binary.available ? binary.version ?? t('ui.settings.available') : t('ui.settings.unavailable')}
            {binary.source ? ` · ${binary.source === 'bundled' ? t('ui.settings.bundled') : t('ui.settings.system')}` : ''}
          </span>
        </div>
        <div className="engine-line__path mono" title={binary.path ?? binary.error}>
          {binary.path ?? binary.error ?? '—'}
        </div>
      </div>
    </div>
  );
}

export function SettingsScreen(): ReactNode {
  const { settings, engine, paths, appVersion, platform, shortcuts, rechecking, busy } = useAppState();
  const { updateSettings, pickOutputDir, recheckEngine, clearTemp, open } = useAppActions();
  const t = useT();
  const [confirmTemp, setConfirmTemp] = useState(false);

  if (!settings) return null;

  const update = (patch: Partial<AppSettings>): void => {
    void updateSettings(patch);
  };

  return (
    <>
      <header className="page-head">
        <div className="page-head__text">
          <p className="eyebrow">{t('ui.settings.eyebrow')}</p>
          <h1>{t('ui.view.settings')}</h1>
          <p className="page-head__sub">{t('ui.settings.sub')}</p>
        </div>
      </header>

      <div className="settings-grid">
        <div className="stack">
          <section className="panel" aria-labelledby="appearance-title">
            <div className="panel__head">
              <h2 id="appearance-title">{t('ui.settings.appearance')}</h2>
            </div>
            <div className="panel__body">
              <div className="field">
                <span className="field__label" id="theme-label">
                  {t('ui.settings.theme')}
                </span>
                <div className="segmented" role="group" aria-labelledby="theme-label">
                  <button
                    type="button"
                    aria-pressed={settings.theme === 'system'}
                    onClick={() => update({ theme: 'system' })}
                  >
                    {t('ui.settings.themeSystem')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={settings.theme === 'light'}
                    onClick={() => update({ theme: 'light' })}
                  >
                    {t('ui.settings.themeLight')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={settings.theme === 'dark'}
                    onClick={() => update({ theme: 'dark' })}
                  >
                    {t('ui.settings.themeDark')}
                  </button>
                </div>
                <span className="field__note">{t('ui.settings.themeNote')}</span>
              </div>
              <div className="field">
                <span className="field__label" id="language-label">
                  {t('ui.settings.language.title')}
                </span>
                <div className="segmented" role="group" aria-labelledby="language-label">
                  <button
                    type="button"
                    aria-pressed={settings.language === 'pt'}
                    onClick={() => void updateSettings({ language: 'pt' })}
                  >
                    {t('ui.settings.language.pt')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={settings.language === 'en'}
                    onClick={() => void updateSettings({ language: 'en' })}
                  >
                    {t('ui.settings.language.en')}
                  </button>
                </div>
                <span className="field__note">{t('ui.settings.language.description')}</span>
              </div>
            </div>
          </section>

          <section className="panel" aria-labelledby="export-settings-title">
            <div className="panel__head">
              <h2 id="export-settings-title">{t('ui.settings.exportPanel')}</h2>
            </div>
            <div className="panel__body">
              <div className="field">
                <span className="field__label">{t('ui.settings.defaultFolder')}</span>
                <div className="field__row">
                  <input className="input mono" value={settings.defaultOutputDir} readOnly spellCheck={false} />
                  <button
                    type="button"
                    className="btn btn--icon"
                    onClick={() => {
                      void pickOutputDir().then((picked) => {
                        if (picked) update({ defaultOutputDir: picked });
                      });
                    }}
                    aria-label={t('ui.settings.changeDefaultFolder')}
                    title={t('ui.settings.changeDefaultFolder')}
                  >
                    <FolderOpen size={15} aria-hidden="true" />
                  </button>
                </div>
                <span className="field__note">{t('ui.settings.defaultFolderNote')}</span>
              </div>
              <Switch
                id="open-result"
                checked={settings.openResultAfterRender}
                onChange={(checked) => update({ openResultAfterRender: checked })}
                label={t('ui.settings.openResult.label')}
                description={t('ui.settings.openResult.desc')}
              />
              <Switch
                id="keep-temp"
                checked={settings.keepTempFiles}
                onChange={(checked) => update({ keepTempFiles: checked })}
                label={t('ui.settings.keepTemp.label')}
                description={t('ui.settings.keepTemp.desc')}
              />
            </div>
          </section>

          <section className="panel" aria-labelledby="network-title">
            <div className="panel__head">
              <h2 id="network-title">{t('ui.settings.network')}</h2>
            </div>
            <div className="panel__body">
              <Switch
                id="allow-remote"
                checked={settings.allowRemoteResources}
                onChange={(checked) => update({ allowRemoteResources: checked })}
                label={t('ui.settings.allowRemote.label')}
                description={t('ui.settings.allowRemote.desc')}
              />
              <p className="calm">{t('ui.settings.networkNote')}</p>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="panel" aria-labelledby="engine-title">
            <div className="panel__head">
              <h2 id="engine-title">{t('ui.settings.engine')}</h2>
              <span className="spacer" />
              <StatusChip status={engine ? (engine.ready ? 'ready' : 'broken') : 'checking'} />
            </div>
            <div className="panel__body">
              <div className="engine-line" data-state="ready">
                <span className="status-dot" data-state="ready" aria-hidden="true" />
                <div className="engine-line__body">
                  <div className="engine-line__title">
                    Chromium
                    <span className="engine-line__value mono">{engine?.chromium.version ?? '—'}</span>
                  </div>
                  <div className="engine-line__path mono">{t('ui.settings.chromiumLine')}</div>
                </div>
              </div>
              {engine ? binaryLine('FFmpeg', engine.ffmpeg, t) : null}
              {engine ? binaryLine('FFprobe', engine.ffprobe, t) : null}
              <div className="engine-line" data-state={engine?.tempDir.writable ? 'ready' : 'broken'}>
                <span className="status-dot" data-state={engine?.tempDir.writable ? 'ready' : 'broken'} aria-hidden="true" />
                <div className="engine-line__body">
                  <div className="engine-line__title">
                    {t('ui.settings.tempSpace')}
                    <span className="engine-line__value mono">
                      {t('ui.settings.freeSpace', { size: formatBytes(engine?.tempDir.freeBytes) })}
                    </span>
                  </div>
                  <div className="engine-line__path mono" title={engine?.tempDir.path}>
                    {engine?.tempDir.path ?? '—'}
                  </div>
                </div>
              </div>
              <div className="engine-actions">
                <button type="button" className="btn" onClick={() => void recheckEngine()} disabled={rechecking}>
                  {rechecking ? <Spinner size={14} /> : <RefreshCw size={14} aria-hidden="true" />}
                  {rechecking ? t('ui.settings.rechecking') : t('ui.settings.recheck')}
                </button>
                <button type="button" className="btn btn--quiet" onClick={() => void open(paths.logs)}>
                  <Terminal size={14} aria-hidden="true" />
                  {t('ui.settings.logs')}
                </button>
              </div>

              {confirmTemp ? (
                <div className="notice" data-kind="warn" role="alert">
                  <Trash2 size={16} aria-hidden="true" className="notice__icon notice__icon--warning" />
                  <div className="notice__body">
                    <div className="notice__title">{t('ui.settings.tempConfirmTitle')}</div>
                    <div className="notice__message">{t('ui.settings.tempConfirmMessage')}</div>
                    <div className="notice__actions">
                      <button
                        type="button"
                        className="btn btn--danger"
                        onClick={() => {
                          setConfirmTemp(false);
                          void clearTemp();
                        }}
                        disabled={busy === 'clear-temp'}
                      >
                        {t('ui.settings.tempDelete')}
                      </button>
                      <button type="button" className="btn btn--quiet" onClick={() => setConfirmTemp(false)}>
                        {t('ui.action.cancel')}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn--quiet engine__clear"
                  onClick={() => setConfirmTemp(true)}
                  disabled={busy === 'clear-temp'}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  {t('ui.settings.tempClear')}
                </button>
              )}
            </div>
          </section>

          <section className="panel" aria-labelledby="security-title">
            <div className="panel__head">
              <h2 id="security-title">{t('ui.settings.security')}</h2>
              <span className="spacer" />
              <ShieldCheck size={16} aria-hidden="true" />
            </div>
            <div className="panel__body">
              <ul className="security-list">
                <li>{t('ui.settings.security.isolated')}</li>
                <li>{t('ui.settings.security.loopback')}</li>
                <li>{t('ui.settings.security.zip')}</li>
                <li>{t('ui.settings.security.blocked')}</li>
                <li>{t('ui.settings.security.copy')}</li>
              </ul>
            </div>
          </section>

          <section className="panel" aria-labelledby="shortcuts-title">
            <div className="panel__head">
              <h2 id="shortcuts-title">{t('ui.settings.shortcuts')}</h2>
            </div>
            <div className="panel__body panel__body--tight">
              <dl className="shortcuts">
                {shortcuts.map((shortcut) => (
                  <div className="shortcuts__row" key={shortcut.id}>
                    <dt>
                      <kbd>{shortcut.keys}</kbd>
                    </dt>
                    <dd>{shortcut.description}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>

          <section className="panel" aria-labelledby="about-title">
            <div className="panel__head">
              <h2 id="about-title">{t('ui.settings.about')}</h2>
            </div>
            <div className="panel__body">
              <dl className="kv">
                <dt>{t('ui.settings.version')}</dt>
                <dd className="mono">Biframe {appVersion}</dd>
                <dt>{t('ui.settings.platform')}</dt>
                <dd>{platformLabel(platform)}</dd>
                <dt>{t('ui.settings.license')}</dt>
                <dd>{t('ui.settings.licenseValue')}</dd>
                <dt>{t('ui.settings.logs')}</dt>
                <dd className="mono">{paths.logs}</dd>
              </dl>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
