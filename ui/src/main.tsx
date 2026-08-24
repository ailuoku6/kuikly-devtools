import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DevtoolsStore } from './store';
import './styles.css';

const store = new DevtoolsStore();

// `?mock=1` drives the panel from synthetic traffic so the UI can be developed without a device.
if (new URLSearchParams(location.search).has('mock')) {
  store.mockMode = true;
  void import('./mock').then(({ startMock }) => startMock(store));
}

const container = document.getElementById('root');
if (!container) throw new Error('#root missing');

createRoot(container).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>
);
