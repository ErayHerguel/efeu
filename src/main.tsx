import '@fontsource-variable/inter';
import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GuestApp } from './GuestApp';
import { QuickNote } from './features/quick/QuickNote';
import { GUEST } from './lib/mode';
import { migrateLegacyStorage } from './lib/legacyStorage';

migrateLegacyStorage();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>{location.hash === '#quick' ? <QuickNote /> : GUEST ? <GuestApp /> : <App />}</ErrorBoundary>
  </StrictMode>,
);
