import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Plugin } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * A strict Content Security Policy for the packaged renderer. In dev, Vite and
 * React Refresh need inline scripts and a websocket; the production build keeps
 * scripts to bundled files only and allows no network connection at all.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'biframe-content-security-policy',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const dev = Boolean(context.server);
        const script = dev ? "'self' 'unsafe-inline'" : "'self'";
        const connect = dev
          ? "'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*"
          : "'self'";
        const policy = [
          "default-src 'self'",
          `script-src ${script}`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: biframe-media:",
          "media-src 'self' blob: biframe-media:",
          "font-src 'self' data:",
          `connect-src ${connect}`,
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-src 'none'",
        ].join('; ');
        return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      },
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': path.join(root, 'src/shared'),
        '@engine': path.join(root, 'src/engine'),
      },
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: path.join(root, 'src/main/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': path.join(root, 'src/shared') },
    },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: path.join(root, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: path.join(root, 'src/renderer'),
    plugins: [react(), contentSecurityPolicy()],
    resolve: {
      alias: {
        '@shared': path.join(root, 'src/shared'),
        '@renderer': path.join(root, 'src/renderer'),
      },
    },
    build: {
      outDir: path.join(root, 'out/renderer'),
      rollupOptions: { input: { index: path.join(root, 'src/renderer/index.html') } },
    },
  },
});
