import { useState, type ReactNode } from 'react';
import {
  FolderOpen,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
} from 'lucide-react';
import { formatBytes } from '@shared/format';
import type { AppSettings } from '@shared/types';
import { useAppActions, useAppState } from '../lib/store';
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
): ReactNode {
  return (
    <div className="engine-line" data-state={binary.available ? 'ready' : 'broken'}>
      <span className="status-dot" data-state={binary.available ? 'ready' : 'broken'} aria-hidden="true" />
      <div className="engine-line__body">
        <div className="engine-line__title">
          {label}
          <span className="engine-line__value mono">
            {binary.available ? binary.version ?? 'disponível' : 'indisponível'}
            {binary.source ? ` · ${binary.source === 'bundled' ? 'incluído' : 'sistema'}` : ''}
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
  const [confirmTemp, setConfirmTemp] = useState(false);

  if (!settings) return null;

  const update = (patch: Partial<AppSettings>): void => {
    void updateSettings(patch);
  };

  return (
    <>
      <header className="page-head">
        <div className="page-head__text">
          <p className="eyebrow">Preferências</p>
          <h1>Definições</h1>
          <p className="page-head__sub">
            Aparência, destino dos ficheiros, rede e o estado real do motor. As alterações são guardadas
            à medida que as faz.
          </p>
        </div>
      </header>

      <div className="settings-grid">
        <div className="stack">
          <section className="panel" aria-labelledby="appearance-title">
            <div className="panel__head">
              <h2 id="appearance-title">Aparência</h2>
            </div>
            <div className="panel__body">
              <div className="field">
                <span className="field__label" id="theme-label">
                  Tema
                </span>
                <div className="segmented" role="group" aria-labelledby="theme-label">
                  <button
                    type="button"
                    aria-pressed={settings.theme === 'system'}
                    onClick={() => update({ theme: 'system' })}
                  >
                    Sistema
                  </button>
                  <button
                    type="button"
                    aria-pressed={settings.theme === 'light'}
                    onClick={() => update({ theme: 'light' })}
                  >
                    Claro
                  </button>
                  <button
                    type="button"
                    aria-pressed={settings.theme === 'dark'}
                    onClick={() => update({ theme: 'dark' })}
                  >
                    Escuro
                  </button>
                </div>
                <span className="field__note">O tema «Sistema» segue a preferência do Windows.</span>
              </div>
            </div>
          </section>

          <section className="panel" aria-labelledby="export-settings-title">
            <div className="panel__head">
              <h2 id="export-settings-title">Exportação</h2>
            </div>
            <div className="panel__body">
              <div className="field">
                <span className="field__label">Pasta predefinida</span>
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
                    aria-label="Alterar pasta predefinida"
                    title="Alterar pasta predefinida"
                  >
                    <FolderOpen size={15} aria-hidden="true" />
                  </button>
                </div>
                <span className="field__note">Novos projetos começam nesta pasta; pode mudar por exportação.</span>
              </div>
              <Switch
                id="open-result"
                checked={settings.openResultAfterRender}
                onChange={(checked) => update({ openResultAfterRender: checked })}
                label="Mostrar o ficheiro ao terminar"
                description="Abre a pasta do sistema com o MP4 seleccionado quando a exportação fica pronta."
              />
              <Switch
                id="keep-temp"
                checked={settings.keepTempFiles}
                onChange={(checked) => update({ keepTempFiles: checked })}
                label="Manter frames intermédios"
                description="Guarda as imagens JPEG da captura para inspecção. Ocupa espaço considerável e não é necessário para exportar."
              />
            </div>
          </section>

          <section className="panel" aria-labelledby="network-title">
            <div className="panel__head">
              <h2 id="network-title">Rede</h2>
            </div>
            <div className="panel__body">
              <Switch
                id="allow-remote"
                checked={settings.allowRemoteResources}
                onChange={(checked) => update({ allowRemoteResources: checked })}
                label="Permitir recursos externos"
                description="Fontes, imagens e scripts em http(s) podem ser carregados pela página. Sem esta opção, o projeto tem de ser autónomo."
              />
              <p className="calm">
                Mesmo com recursos externos ligados, pedidos para endereços privados, locais ou de
                metadados do sistema são bloqueados. A página nunca recebe acesso ao Node.js, ao disco ou
                à rede interna através do Biframe.
              </p>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="panel" aria-labelledby="engine-title">
            <div className="panel__head">
              <h2 id="engine-title">Motor</h2>
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
                  <div className="engine-line__path mono">incluído no Electron · compositor offscreen</div>
                </div>
              </div>
              {engine ? binaryLine('FFmpeg', engine.ffmpeg) : null}
              {engine ? binaryLine('FFprobe', engine.ffprobe) : null}
              <div className="engine-line" data-state={engine?.tempDir.writable ? 'ready' : 'broken'}>
                <span className="status-dot" data-state={engine?.tempDir.writable ? 'ready' : 'broken'} aria-hidden="true" />
                <div className="engine-line__body">
                  <div className="engine-line__title">
                    Espaço temporário
                    <span className="engine-line__value mono">{formatBytes(engine?.tempDir.freeBytes)} livres</span>
                  </div>
                  <div className="engine-line__path mono" title={engine?.tempDir.path}>
                    {engine?.tempDir.path ?? '—'}
                  </div>
                </div>
              </div>
              <div className="engine-actions">
                <button type="button" className="btn" onClick={() => void recheckEngine()} disabled={rechecking}>
                  {rechecking ? <Spinner size={14} /> : <RefreshCw size={14} aria-hidden="true" />}
                  {rechecking ? 'A verificar…' : 'Verificar novamente'}
                </button>
                <button type="button" className="btn btn--quiet" onClick={() => void open(paths.logs)}>
                  <Terminal size={14} aria-hidden="true" />
                  Registos
                </button>
              </div>

              {confirmTemp ? (
                <div className="notice" data-kind="warn" role="alert">
                  <Trash2 size={16} aria-hidden="true" className="notice__icon notice__icon--warning" />
                  <div className="notice__body">
                    <div className="notice__title">Apagar ficheiros temporários?</div>
                    <div className="notice__message">
                      Remove frames e posters guardados. As exportações concluídas não são afectadas.
                    </div>
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
                        Apagar
                      </button>
                      <button type="button" className="btn btn--quiet" onClick={() => setConfirmTemp(false)}>
                        Cancelar
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
                  Limpar ficheiros temporários
                </button>
              )}
            </div>
          </section>

          <section className="panel" aria-labelledby="security-title">
            <div className="panel__head">
              <h2 id="security-title">Segurança</h2>
              <span className="spacer" />
              <ShieldCheck size={16} aria-hidden="true" />
            </div>
            <div className="panel__body">
              <ul className="security-list">
                <li>A página corre num Chromium isolado, sem Node.js nem acesso ao sistema.</li>
                <li>O projeto é servido por HTTP em loopback, com um token aleatório por sessão.</li>
                <li>ZIPs com travessia de caminho, ligações simbólicas ou nomes reservados são recusados.</li>
                <li>Pedidos para a rede privada, downloads e novas janelas são bloqueados.</li>
                <li>O ficheiro importado nunca é alterado; o Biframe trabalha sobre uma cópia.</li>
              </ul>
            </div>
          </section>

          <section className="panel" aria-labelledby="shortcuts-title">
            <div className="panel__head">
              <h2 id="shortcuts-title">Atalhos</h2>
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
              <h2 id="about-title">Sobre</h2>
            </div>
            <div className="panel__body">
              <dl className="kv">
                <dt>Versão</dt>
                <dd className="mono">Biframe {appVersion}</dd>
                <dt>Plataforma</dt>
                <dd>{platformLabel(platform)}</dd>
                <dt>Licença</dt>
                <dd>MIT · código aberto</dd>
                <dt>Registos</dt>
                <dd className="mono">{paths.logs}</dd>
              </dl>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
