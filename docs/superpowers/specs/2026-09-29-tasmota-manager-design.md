# Tasmota Manager – Design

- **Datum:** 2026-09-29
- **Status:** Entwurf zur Freigabe
- **Arbeitstitel:** Tasmota Manager

## 1. Ziel und Kontext

Eine Home Assistant App (ehemals „Add-on“), die alle Tasmota-Geräte im lokalen Netzwerk zentral verwaltet – funktional vergleichbar mit TasmoAdmin, aber mit modernem Interface und echter Batch-Konfiguration.

**Erfolgskriterium:** Ein Nutzer kann z. B. 30 Geräte auswählen, in einem Schritt eine Konfiguration (MQTT-Server, Zeitzone, `SetOption`s …) oder ein Firmware-Update anwenden und sieht pro Gerät das Ergebnis.

### Umfang v1

1. Geräteübersicht + Discovery
2. Batch-Bearbeitung über einen Änderungspuffer (Einstellungsformular, freie Befehle, Namensvorschläge, Rules/Timer), dazu HA-Links. Details und Abweichungen stehen in `2026-09-29-plan-2-staging-batch-design.md`.

> **Aktualisierung (Plan 2):** Alle Änderungen an Geräten werden zuerst vorgemerkt und erst beim Start eines Batch-Vorgangs geschrieben. Die Konfigurationsvorlagen (§3.3 `templates/`, §4 `templates`, §5.3, §6 „Vorlagen“) entfallen vorerst. Wo diese Spec und die Plan-2-Spec sich widersprechen, gilt die Plan-2-Spec.
3. Firmware-Updates (OTA), einzeln und im Batch
4. Config-Backups (einzeln, im Batch, Wiederherstellung einzeln)

### Nicht in v1

- Anlegen von HA-Entities (übernimmt die offizielle Tasmota-Integration)
- Dauerhafte Drift-/Compliance-Überwachung gegen Vorlagen (Verify-Funktion ist die Grundlage für später)
- Batch-Wiederherstellung von Backups

## 2. Rahmenbedingungen und Entscheidungen

| Thema | Entscheidung |
|---|---|
| Kommunikation | Hybrid: MQTT bevorzugt, HTTP als Fallback. Geräte ohne MQTT erhalten alle Funktionen per HTTP, soweit technisch möglich. |
| Sprache/Stack | TypeScript durchgehend: Node 22, Fastify, mqtt.js, undici, SQLite (`better-sqlite3` + Drizzle ORM), pino |
| Frontend | React + shadcn/ui, TanStack Table, TanStack Query, Vite |
| UI-Zugang | HA Ingress (Seitenleiste, kein eigener Login) |
| Gerätezugang | Globales Web-Passwort + Override pro Gerät |
| Sprachen UI | Deutsch und Englisch (i18n von Anfang an, Sprache folgt HA) |
| Architekturen | amd64, aarch64 |

## 3. Architektur

### 3.1 Laufzeit

- Ein Container (Node 22 auf Alpine-Basis), `ingress: true`, `host_network: true` (nötig für Subnetz-Scans und direkten HTTP-Zugriff auf Geräte).
- Persistenz in `/data`: SQLite-Datenbank, Backups, hochgeladene Firmware.
- Ein zusätzlicher, im LAN erreichbarer **Firmware-Port** (konfigurierbar, Standard `8266`) liefert hochgeladene Firmware-Dateien für `OtaUrl` aus. Er liefert ausschließlich Dateien aus `/data/firmware/` per nicht erratbarem Dateinamen (UUID) aus.
- MQTT-Zugangsdaten werden automatisch über die Supervisor-Services-API bezogen (`services: ["mqtt:want"]`) und sind in der App-Konfiguration überschreibbar. Ohne Broker läuft die App vollständig im HTTP-Modus.

### 3.2 Repository-Struktur (pnpm workspaces)

Das Repository ist gleichzeitig ein HA-App-Repository. Der Supervisor baut eine App lokal nur aus ihrem eigenen Ordner heraus (Build-Kontext = App-Ordner). Deshalb liegt das komplette Monorepo **im** App-Ordner `tasmota_manager/`. So funktioniert die Installation direkt über die Repository-URL, ohne eine eigene Container-Registry.

```
tasmota-manager/                 # Git-Repository = HA-App-Repository
├─ repository.yaml
├─ docs/                         # Specs und Pläne
└─ tasmota_manager/              # App-Ordner = pnpm-Monorepo-Wurzel
   ├─ config.yaml, Dockerfile, DOCS.md, translations/
   ├─ packages/shared/           # TS-Typen + zod-Schemas (API-Verträge, Gerätemodell)
   ├─ packages/server/           # Fastify-Backend
   └─ packages/web/              # React + shadcn/ui SPA (wird als statisches Bundle vom Server ausgeliefert)
```

**Zugriffsschutz:** Wegen `host_network: true` ist der Ingress-Port auch im LAN erreichbar. Läuft die App unter dem Supervisor, nimmt der Server deshalb nur Anfragen vom Ingress-Proxy (`172.30.32.2`) und von `127.0.0.1` an.

### 3.3 Backend-Module

| Modul | Verantwortung | Schnittstelle nach außen |
|---|---|---|
| `transport/` | `MqttTransport` und `HttpTransport` mit identischer Schnittstelle | `send(device, command, opts) → CommandResult` |
| `transport/gateway` | `DeviceGateway` wählt pro Gerät den Kanal (MQTT, wenn dort online, sonst HTTP) und weicht bei Fehlern einmal auf den anderen Kanal aus | `send(deviceId, command)`, `fetchBackup(deviceId)`, `restoreBackup(deviceId, file)` |
| `discovery/` | MQTT: abonniert `tasmota/discovery/#`, LWT, `STATE`, `STATUS*`. HTTP: scannt konfigurierbare CIDRs (Standard: Host-Subnetz) und identifiziert Geräte über `Status 0`. Manuelles Hinzufügen per IP. HTTP-Polling für Geräte ohne MQTT. | Events `device:seen`, `device:offline` |
| `registry/` | Geräteinventar in SQLite; Zusammenführung über MAC als stabile ID | CRUD + Abfragen, Events `device:updated` |
| `jobs/` | Job-Engine für alle Batch-Aktionen: persistiert, begrenzte Parallelität, Timeouts pro Gerät, Abbruch | `createJob(spec)`, `cancelJob(id)`, Events `job:progress` |
| `templates/` | Vorlagen verwalten, Platzhalter rendern | `render(template, device) → string[]` |
| `firmware/` | Offizielle Versionen abfragen, Uploads verwalten, OTA-URL je Gerät bestimmen | `resolveOtaUrl(device, target)` |
| `backups/` | Backup-Dateien speichern, Aufbewahrung durchsetzen, ZIP-Export | `store`, `list`, `prune`, `zip` |
| `api/` | REST-Endpunkte + ein WebSocket für Live-Updates (Gerätestatus, Job-Fortschritt) | HTTP/WS, validiert mit zod aus `shared` |

## 4. Datenmodell (SQLite, Migrationen via Drizzle)

Datei: `/data/tasmota-manager.db`

| Tabelle | Felder |
|---|---|
| `devices` | `id` (MAC, normalisiert, PK), `name` (FriendlyName), `hostname`, `ip`, `mqtt_topic`, `module`, `firmware`, `variant` (z. B. `tasmota`, `tasmota-sensors`, `tasmota32`), `chip` (ESP8266/ESP32-Variante), `flash_size`, `online` (bool), `channels` (Menge aus `mqtt`, `http`), `last_seen`, `status_json` (letzte `Status 0`-Antwort), `password_override` (nullable), `created_at` |
| `tags` | `id`, `name` (unique), `color` |
| `device_tags` | `device_id`, `tag_id` |
| `templates` | `id`, `name`, `description`, `commands` (JSON-Array von Strings mit Platzhaltern), `verify` (bool), `created_at`, `updated_at` |
| `jobs` | `id`, `type` (`command` \| `template` \| `ota` \| `backup`), `params_json`, `status` (`pending` \| `running` \| `done` \| `cancelled`), `concurrency`, `created_at`, `started_at`, `finished_at` |
| `job_items` | `id`, `job_id`, `device_id`, `status` (`pending` \| `running` \| `success` \| `failed` \| `skipped` \| `cancelled`), `channel`, `result_json`, `error_code`, `error_message`, `started_at`, `finished_at` |
| `backups` | `id`, `device_id`, `created_at`, `firmware`, `path` (`/data/backups/<mac>/<timestamp>.dmp`), `size`, `sha256`, `label`, `job_id` (nullable) |
| `settings` | `key`, `value_json` |

**Platzhalter in Vorlagen:** `{{name}}`, `{{hostname}}`, `{{topic}}`, `{{mac}}`, `{{mac6}}` (letzte 6 Hex-Stellen), `{{ip}}`. Unbekannte Platzhalter sind ein Validierungsfehler in der Vorschau.

**Settings (Standardwerte):** globales Passwort (leer), Scan-CIDRs (Host-Subnetz), Poll-Intervall 60 s, Parallelität (Befehle 10, OTA 3, Backup 5), Backup-Aufbewahrung 10 pro Gerät, Firmware-Port 8266.

**Passwörter** werden nie an die UI zurückgegeben (write-only; die API liefert nur `hasPassword`). Es gibt keine Verschlüsselung at rest, weil der Schlüssel im selben Container läge. Schutz entsteht durch den Ingress-Zugang und `/data`.

## 5. Abläufe

### 5.1 Discovery

- **MQTT:** Die Discovery-Nachrichten (`tasmota/discovery/<mac>/config`) liefern MAC, IP, Topic, Name und Firmware. LWT (`tele/<topic>/LWT`) setzt `online`, `tele/<topic>/STATE` aktualisiert Laufzeitwerte. Beim ersten Fund wird `Status 0` angefordert.
- **HTTP-Scan:** manuell per Knopf oder beim Start. Alle IPs der konfigurierten CIDRs werden mit begrenzter Parallelität (32) und kurzem Timeout (1,5 s) per `GET /cm?cmnd=Status%200` abgefragt. Antworten im Tasmota-Format ergeben ein Gerät. Ein 401 ergibt ein Gerät im Zustand „Passwort erforderlich“.
- **Zusammenführung:** über die MAC. Ein Gerät, das über beide Wege gefunden wird, hat `channels = {mqtt, http}`.
- **Polling:** Geräte ohne MQTT-Kanal werden im Poll-Intervall per `Status 0` aktualisiert. Nach 3 Fehlschlägen gelten sie als offline.

### 5.2 Gemeinsamer Batch-Ablauf

1. **Auswahl** in der Gerätetabelle (Mehrfachauswahl, Filter, Tags)
2. **Vorschau (Dry-Run):** gerenderte Befehle pro Gerät, dazu Warnungen: Gerät offline, Befehl löst Neustart aus, kein HTTP-Zugang (bei Backup/OTA), Firmware bereits aktuell, unbekannter Platzhalter
3. **Bestätigung:** Der Job wird in der Datenbank angelegt.
4. **Ausführung:** begrenzte Parallelität je Job-Typ, Timeout pro Gerät. Fortschritt wird per WebSocket gesendet.
5. **Ergebnis:** eine Ansicht pro Gerät und die Aktion „Fehlgeschlagene erneut ausführen“ (erzeugt einen neuen Job nur mit den fehlgeschlagenen Geräten)

**Neustart der App während eines Jobs:** Items im Zustand `running` werden auf `failed` gesetzt (Code `interrupted`), `pending`-Items laufen weiter.

### 5.3 Befehle und Vorlagen

- Pro Gerät werden die Befehle **einzeln und nacheinander** gesendet, damit jeder Befehl ein eigenes Ergebnis liefert. `Backlog` wird nicht verwendet, weil es per HTTP nur „Done“ zurückgibt.
- Befehle, die einen Neustart auslösen (gepflegte Liste im Code, z. B. `Restart`, `MqttHost`, `Module`, `Template` mit Neustart, `WifiConfig`, `SetOption` mit Neustart), führen dazu, dass der Job wartet, bis das Gerät wieder online ist (Timeout 90 s). Erst danach folgt der nächste Befehl.
- **Verify:** Ist `verify` aktiv, wird nach dem letzten Befehl jeder gesetzte Wert per Abfrage (gleicher Befehl ohne Argument) zurückgelesen und verglichen. Abweichungen machen das Item zu `failed` (Code `verify_mismatch`), mit Soll- und Ist-Wert.

### 5.4 OTA

- **Firmware-Ziel:**
  - *Offiziell:* `ota.tasmota.com`. Die Variante wird aus `Status 2` abgeleitet, die Zielversion lautet „neueste“ oder eine ausgewählte Version.
  - *Eigene URL* oder *Upload:* Hochgeladene Dateien werden über den Firmware-Port bereitgestellt.
- **Ablauf pro Gerät:** `OtaUrl <url>` setzen, dann `Upgrade 1` (über MQTT oder HTTP). Das Update gilt als erfolgreich, wenn das Gerät wieder online ist und die erwartete Version meldet (Timeout 5 Minuten).
- **Offener Punkt für die Umsetzung:** Das Verhalten beim Zwischenschritt über die Minimal-Firmware bei ESP8266 mit wenig Flash wird gegen die aktuelle Tasmota-Dokumentation geprüft und entsprechend behandelt (automatisch zweistufig oder als Warnung in der Vorschau).
- Nach dem Update wird `OtaUrl` nicht zurückgesetzt, es sei denn, der Nutzer wählt das aus.

### 5.5 Backup und Wiederherstellung

- **Backup:** nur per HTTP (`GET /dl`, mit Authentifizierung), weil Tasmota Konfigurations-Dumps nicht über MQTT anbietet. Die IP ist auch bei MQTT-Geräten über den Status bekannt. Der Dump wird unter `/data/backups/<mac>/` gespeichert, mit Firmware-Version und `sha256`. Danach wird die Aufbewahrungsregel angewendet.
- **Export:** einzelne Datei oder alle (bzw. ausgewählte) Geräte als ZIP.
- **Wiederherstellung:** nur für ein einzelnes Gerät, per Upload an die Restore-Seite des Geräts und mit Sicherheitsabfrage. Das Ergebnis gilt als bestätigt, wenn das Gerät nach dem Neustart wieder online ist.

### 5.6 Reine HTTP-Geräte

Alle Funktionen (Befehle, Vorlagen, OTA, Backup) stehen auch über HTTP zur Verfügung. Nur der Live-Status fehlt; er wird durch Polling ersetzt (5.1).

## 6. UI

Die UI folgt dem HA-Theme (hell/dunkel) und hat eine Seitennavigation:

- **Geräte:** TanStack Table mit Mehrfachauswahl, Suche, Filtern (Tag, Status, Firmware, Kanal), Sortierung und frei wählbaren Spalten. Eine Aktionsleiste für die Auswahl bietet Befehl, Vorlage, Update, Backup und Tags. Knopf „Scan“.
- **Gerätedetail:** Status, Konsole (einzelne Befehle mit Verlauf), Backups, Tags, Passwort-Override, Direktaktionen (Toggle, Neustart, Weboberfläche öffnen) ohne Job.
- **Vorlagen:** Editor für Befehlslisten mit Platzhalter-Autovervollständigung und Live-Vorschau für ein Beispielgerät.
- **Firmware:** verfügbare offizielle Versionen, hochgeladene Dateien, Stand der Geräte.
- **Backups:** Liste pro Gerät, Download einzeln oder als ZIP, Wiederherstellen.
- **Jobs:** laufende und vergangene Jobs mit Fortschritt und Ergebnissen pro Gerät, Abbruch, „Fehlgeschlagene erneut ausführen“.
- **Einstellungen:** globales Passwort, Scan-CIDRs, Poll-Intervall, Parallelität, Aufbewahrung, Firmware-Port, MQTT-Verbindungsstatus.

## 7. Fehlerbehandlung

- **Timeouts:** MQTT 5 s, HTTP 10 s pro Befehl (OTA und Neustart-Warten separat, siehe oben).
- **Kanal-Fallback:** Ist ein Gerät über beide Kanäle erreichbar, wird bei einem Fehler einmal auf den anderen Kanal ausgewichen.
- **Fehlercodes:** `offline`, `auth`, `timeout`, `rejected` (Tasmota antwortet mit `Unknown`/`Error`), `unreachable`, `interrupted`, `verify_mismatch`, `version_mismatch`.
- **MQTT-Verbindung:** Reconnect mit exponentiellem Backoff. Solange der Broker nicht verfügbar ist, laufen alle Geräte über HTTP, und die UI zeigt einen Hinweis.
- **Jobs:** Ein Fehler bei einem Gerät bricht den Batch nie ab.
- **Validierung:** Alle API-Ein- und -Ausgaben werden mit zod-Schemas aus `packages/shared` geprüft, auf Server und Client identisch.
- **Logging:** strukturiert mit pino, im App-Log sichtbar. Passwörter werden aus Logs und URLs entfernt.

## 8. Tests

- **Unit (Vitest):** Platzhalter-Rendering, Parsing von Tasmota-Antworten, Kanalwahl und Fallback im Gateway, Job-Scheduler (Parallelität, Abbruch, Wiederaufnahme nach Neustart), Erkennung von Neustart-Befehlen, Verify-Vergleich.
- **Integration:** simuliertes Tasmota-Gerät (Fake mit `/cm`, `/dl`, Restore und Upgrade-Verhalten sowie den MQTT-Topics) und eingebetteter MQTT-Broker (Aedes). Abgedeckt werden Discovery (MQTT und HTTP-Scan), Batch-Vorlagen mit Neustart und Verify, OTA-Ablauf und Backup/Restore end-to-end ohne echte Hardware.
- **Frontend:** Komponententests mit Testing Library, dazu ein Playwright-Smoke-Test gegen das Backend mit Fake-Geräten.
- **Manuell vor Release:** Checkliste mit echten Geräten (ESP8266 und ESP32, jeweils mit MQTT und nur HTTP).
- **CI:** GitHub Actions: Lint, Tests, Multi-Arch-Image-Build (amd64, aarch64) mit dem HA-Builder.
