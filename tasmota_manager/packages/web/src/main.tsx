import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme } from './lib/ha';
import { I18nProvider, detectLanguage } from './lib/i18n';
import './index.css';

applyTheme();
const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider lang={detectLanguage()}>
        <App />
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
