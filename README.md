# Tasmota Manager für Home Assistant

Home-Assistant-App zur Verwaltung und Batch-Konfiguration von Tasmota-Geräten.

## Installation

Einstellungen → Apps → App-Store → ⋮ → Repositories → die URL dieses Repositorys hinzufügen, dann „Tasmota Manager“ installieren.

## Entwicklung

```bash
cd tasmota_manager
pnpm install
pnpm test
pnpm dev:server   # API auf :8099, Daten in tasmota_manager/.data
pnpm dev:web      # Vite auf :5173, leitet /api an :8099 weiter
```
