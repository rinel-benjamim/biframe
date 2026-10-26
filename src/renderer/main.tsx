import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import { App } from './app';

const container = document.getElementById('root');
if (!container) throw new Error('root container is missing');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
