import { describe, expect, it, vi } from 'vitest';

const { nativeTheme } = vi.hoisted(() => ({
  nativeTheme: { shouldUseDarkColors: true, themeSource: 'system' },
}));

vi.mock('electron', () => ({
  nativeTheme,
  BrowserWindow: class BrowserWindow {},
}));

import { chromePalette, resolveEffectiveTheme } from '../../src/main/window';

describe('effective theme resolution', () => {
  it('trusts explicit themes over the operating system', () => {
    nativeTheme.shouldUseDarkColors = true;
    expect(resolveEffectiveTheme('light')).toBe('light');
    nativeTheme.shouldUseDarkColors = false;
    expect(resolveEffectiveTheme('dark')).toBe('dark');
  });

  it('follows nativeTheme only for the system setting', () => {
    nativeTheme.shouldUseDarkColors = true;
    expect(resolveEffectiveTheme('system')).toBe('dark');
    nativeTheme.shouldUseDarkColors = false;
    expect(resolveEffectiveTheme('system')).toBe('light');
  });
});

describe('chrome palette', () => {
  it('provides the light and dark titlebar colours', () => {
    expect(chromePalette(false)).toEqual({ chrome: '#F1F0EC', symbol: '#17171A' });
    expect(chromePalette(true)).toEqual({ chrome: '#141417', symbol: '#ECECEE' });
  });
});
