import { BrowserWindow, nativeTheme } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, EffectiveTheme } from '@shared/types';

/**
 * The application window.
 *
 * The window uses a hidden title bar with the native control overlay, so the
 * interface draws its own tinted frame (the "framed sheet" shell) while the
 * minimise/maximise/close buttons remain the real Windows ones. The overlay is
 * re-coloured whenever the effective theme changes; the renderer receives the
 * same palette through its CSS tokens.
 */

export const TITLEBAR_HEIGHT = 40;

export interface ChromePalette {
  chrome: string;
  symbol: string;
}

export function chromePalette(dark: boolean): ChromePalette {
  return dark ? { chrome: '#141417', symbol: '#ECECEE' } : { chrome: '#F1F0EC', symbol: '#17171A' };
}

/**
 * Resolves the theme the interface should wear. The renderer's
 * `prefers-color-scheme` cannot be trusted on every Windows configuration
 * (it can disagree with `nativeTheme`), so both sides use this one answer:
 * the main process resolves it and sends it to the window.
 */
export function resolveEffectiveTheme(theme: AppSettings['theme']): EffectiveTheme {
  if (theme === 'light' || theme === 'dark') return theme;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function windowIcon(): string | undefined {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'icon.png'),
    path.join(process.resourcesPath ?? '', 'build', 'icon.png'),
    path.join(process.cwd(), 'build', 'icon.png'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function createMainWindow(): BrowserWindow {
  const icon = windowIcon();
  const palette = chromePalette(nativeTheme.shouldUseDarkColors);
  const window = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1060,
    minHeight: 700,
    show: false,
    backgroundColor: palette.chrome,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: palette.chrome, symbolColor: palette.symbol, height: TITLEBAR_HEIGHT },
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !process.env.BIFRAME_DISABLE_DEVTOOLS,
      backgroundThrottling: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return window;
}

export function applyTheme(window: BrowserWindow, theme: 'system' | 'light' | 'dark'): EffectiveTheme {
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
  const effective = resolveEffectiveTheme(theme);
  const palette = chromePalette(effective === 'dark');
  try {
    if (!window.isDestroyed()) {
      window.setTitleBarOverlay({ color: palette.chrome, symbolColor: palette.symbol, height: TITLEBAR_HEIGHT });
    }
  } catch {
    // Linux and some window managers have no overlay; the interface still themes itself.
  }
  try {
    if (!window.isDestroyed()) window.setBackgroundColor(palette.chrome);
  } catch {
    // Not fatal.
  }
  return effective;
}
