# Tasmota Manager – Design Plan 2: Änderungspuffer, Batch-Bearbeitung, HA-Anbindung

- **Datum:** 2026-09-29
- **Status:** Entwurf zur Freigabe
- **Basis:** `2026-09-29-tasmota-manager-design.md` (Gesamt-Spec) und Plan 1 (umgesetzt: Discovery, Inventar, Transports, Gateway, API, Geräteübersicht, Packaging)
- **Offene Nacharbeiten aus Plan 1:** `docs/superpowers/plans/2026-09-29-plan-1-followups.md`

## 1. Ziel

Plan 2 macht aus der Geräteübersicht ein Werkzeug zur Massenkonfiguration. Alle Änderungen an Geräten werden zuerst **vorgemerkt** und erst beim Start eines Batch-Vorgangs geschrieben. Dazu kommen:

- Links auf die zugehörigen Home-Assistant-Entitäten und -Automationen
- Namensvorschläge für generisch benannte Geräte
- ein Editor für Rules und Timer

**Erfolgskriterien:**

- Der Nutzer wählt z. B. 20 Geräte aus und setzt im Formular `PowerOnState` und `LedState`. Die App merkt die Werte vor, zeigt pro Gerät Vorher und Nachher und schreibt sie nach „Batch starten“. Fehlgeschlagene Einträge bleiben stehen und lassen sich erneut starten.
- Ein Gerät namens „Tasmota“ mit AM2301-Sensor im HA-Bereich „Bad“ zeigt den Vorschlag „Klima Bad“. Ein Klick darauf merkt den Namen vor.

## 2. Grundprinzip: Änderungspuffer

**Alles, was Konfiguration auf einem Gerät ändert, geht in den Puffer:**

- Umbenennen und Namensvorschläge
- das Einstellungsformular (einzeln oder im Batch)
- freie Befehle im Batch
- Rules und Timer

Geschrieben wird ausschließlich durch einen gestarteten Batch-Vorgang.

**Sofort wirksam bleiben:**

- rein lokale App-Daten: Tags und das Passwort pro Gerät
- die Konsole in der Detailansicht
- Direktaktionen: Schalten und Neustart

Diese ändern keine Konfiguration auf dem Gerät.

**Speicherort:** Der Puffer liegt auf dem Server in der Datenbank. Er übersteht Neuladen, Browserwechsel und App-Neustart und ist für alle HA-Nutzer derselbe.

## 3. Einstellungskatalog

Die Einstellungen sind fest definiert: Die Definitionen stehen in `packages/server/src/catalog.ts`, die Typen und Schlüssel in `@tm/shared`.

**Jeder Eintrag hat:**

- `key` (zugleich Tasmota-Befehl) und `group`
- Beschriftung (de/en)
- zod-Validierung des Werts
- `readFromStatus(status0)`, falls der aktuelle Wert im gespeicherten `Status 0` steht, sonst `readCommand` (Lesebefehl ohne Argument)
- `restarts` (löst Neustart aus)
- `writeOnly` (Passwort: nie ausgeben, nicht verifizieren)
- `order` (Schreibreihenfolge)

| Gruppe | Schlüssel | Hinweise |
|---|---|---|
| Namen | `DeviceName`, `FriendlyName1` | Namensvorschläge setzen beide |
| Stromausfall | `PowerOnState` (0–5), `SetOption65` (0/1) | |
| LED | `LedState` (0–8), `LedPower` (0/1) | |
| System | `Sleep` (0–250), `SetOption53` (0/1) | |
| Logging | `LogHost`, `SysLog` (0–4) | |
| Standort | `Latitude`, `Longitude` | nötig für Timer mit Sonnenstand |
| Zeit | `Timezone`, `NtpServer1` | |
| Telemetrie | `TelePeriod` (10–3600) | |
| MQTT | `MqttHost`, `MqttPort`, `MqttUser`, `MqttPassword` (writeOnly) | lösen einen Neustart aus, werden pro Gerät zuletzt und gebündelt in einem `Backlog` geschrieben (Abschnitt 5) |

**Weitere Puffer-Schlüssel außerhalb des Formulars:**

- `Rule1`–`Rule3` (Text) und `Rule1Enabled`–`Rule3Enabled` (0/1, Befehl `RuleN 0|1`)
- `Timer1`–`Timer16` (JSON) und `Timers` (0/1)

**Nicht im Katalog:**

- `SetOption19`: In Release-Builds hat sie nur den Wert 0, ein Batch-Feld hätte also keinen Nutzen.
- `SetOption4`: Sie würde die MQTT-Antwortzuordnung (`RESULT`) brechen. Stattdessen wird `SetOption4 1` erkannt (Abschnitt 8).

## 4. Datenmodell (neue Tabellen, Drizzle-Migration)

**`pending_changes`:**

| Feld | Inhalt |
|---|---|
| `id` | Schlüssel |
| `device_id` | Fremdschlüssel mit Cascade-Delete |
| `kind` | `setting` \| `command` |
| `key` | nur bei `setting` |
| `value` | Text |
| `position` | Reihenfolge bei `command` |
| `source` | `suggestion` \| `form` \| `command` \| `detail` \| `rule` \| `timer` |
| `error` | Text, nullable; letzter Fehler eines Laufs |
| `created_at`, `updated_at` | Zeitstempel |

- Eindeutig ist `(device_id, key)` für `kind = setting`. Eine erneute Änderung überschreibt den Eintrag, es gilt also der letzte Wert.
- `command`-Einträge werden angehängt.
- Ein Eintrag, dessen Wert gleich dem aktuellen, bekannten Gerätewert ist, wird beim Vormerken verworfen.

**`jobs` und `job_items`:** wie in der Gesamt-Spec, mit dem Job-Typ `apply`. Jedes `job_item` referenziert ein Gerät und speichert die IDs der verarbeiteten Puffer-Einträge.

**`devices`:** Neu ist das Feld `sensors_json` (letzte `StatusSNS` aus `Status 10`) für die Namensvorschläge. Es wird bei der Identifikation (HTTP) und beim Status-Refresh (MQTT) mitgelesen.

## 5. Ablauf und API

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/changes` | Puffer gruppiert nach Gerät, mit `before` (bekannter Wert oder `null`), `after`, `error`; writeOnly-Werte als `"••••"` |
| `POST` | `/api/changes` | Einträge für viele Geräte vormerken: `{ deviceIds, settings?: {key: value}, commands?: string[], source }`. Validiert gegen den Katalog. Antwort: Anzahl vorgemerkt / verworfen |
| `POST` | `/api/changes/suggestions` | `{ deviceIds }`: Namensvorschläge vormerken, soweit vorhanden |
| `DELETE` | `/api/changes/:id`, `/api/changes?deviceId=`, `/api/changes` | verwerfen |
| `POST` | `/api/changes/apply` | `{ deviceIds? }`: Job starten (409, falls bereits ein Apply-Job läuft) |
| `GET` | `/api/devices/:id/rules` | liest Rules live vom Gerät |
| `GET` | `/api/devices/:id/timers` | liest Timer live vom Gerät |

**Batch-Ausführung pro Gerät:**

Die Parallelität richtet sich nach `settings.concurrency.command`. Pro Gerät laufen die Schritte streng nacheinander:

1. **Einstellungen ohne Neustart:** einzeln in `order`-Reihenfolge, jede mit eigenem Ergebnis.
2. **Rules und Timer:** einzeln geschrieben.
3. **Freie Befehle:** in ihrer Reihenfolge. Nach einem bekannten Neustart-Befehl wartet der Job auf den Neustart, bevor der nächste Befehl folgt.
4. **Einstellungen mit Neustart** (`restarts`, derzeit die MQTT-Gruppe): alle zusammen in **einem** `Backlog`, danach auf den Neustart warten. So startet das Gerät pro Batch nur einmal neu. Einzelergebnisse gibt es dabei nicht (Backlog meldet nur „Done“), die Prüfung übernimmt Schritt 5.
5. **Verify:** Alle nicht-writeOnly-Einstellungen, Rules und Timer werden zurückgelesen und verglichen. Nach MQTT-Änderungen geschieht das per HTTP, falls die IP bekannt ist, sonst entfällt es mit einem Hinweis.

**Bekannte Neustart-Befehle** (gepflegte Liste im Code): `Restart`, `Module`, `Template` (mit Aktivierung), `Topic`, `FullTopic`, `GroupTopic`, `Hostname`, `WifiConfig`, `SSId1`/`SSId2`, `Password1`/`Password2`, `IPAddress1`–`4`, `MqttHost`, `MqttPort`, `MqttUser`, `MqttPassword`, `MqttClient`, `Reset` und `Upgrade`.

**Neustart erkennen:**

- Vor dem auslösenden Befehl merkt sich der Job `UptimeSec` des Geräts.
- Danach fragt er über den verfügbaren Kanal `Status 11` ab und zählt den Neustart erst dann als erfolgt, wenn die gemeldete Laufzeit **kleiner** als der gemerkte Wert ist. Der bloße Online-Status reicht nicht, weil Tasmota erst ein bis zwei Sekunden nach dem Befehl neu startet.
- Bei MQTT gilt die Folge LWT „Offline“ → „Online“ zusätzlich als Signal.
- Timeout: 90 s.

**Unerwartete Neustarts:** Löst ein Befehl, der nicht in der Liste steht, einen Neustart aus, antwortet das Gerät kurzzeitig nicht. Folgebefehle und der Verify versuchen es dann innerhalb des 90-s-Fensters mit Backoff erneut, bevor sie als `offline` scheitern.

**Gerät kommt nicht zurück** (z. B. falscher MQTT- oder WLAN-Wert): Die noch offenen Einträge des Geräts werden als `offline` markiert und bleiben mit Hinweis im Puffer. Einträge, die vorher erfolgreich geschrieben und geprüft wurden, werden trotzdem entfernt.

**Ergebnis:**

- Erfolgreiche Einträge werden aus dem Puffer gelöscht.
- Fehlgeschlagene bleiben mit `error` stehen. Die Fehlercodes stammen aus der Gesamt-Spec, dazu kommt `verify_mismatch` mit Soll und Ist.
- Freie Befehle gelten als erfolgreich, wenn das Gerät sie nicht ablehnt.

**Live-Updates per WebSocket:**

- `changes:updated` (Puffer geändert)
- `job:progress` (pro Gerät: Status und aktueller Schritt)
- `job:done`

**Neustart der App während eines Jobs:** Laufende Items werden `failed` (`interrupted`). Die zugehörigen Puffer-Einträge bleiben mit diesem Fehler stehen.

## 6. Home-Assistant-Anbindung

**Zugriff:**

- `config.yaml` bekommt `homeassistant_api: true`.
- Der Server verbindet sich mit `ws://supervisor/core/websocket` und dem `SUPERVISOR_TOKEN`.
- In der lokalen Entwicklung sind `TM_HA_URL` und `TM_HA_TOKEN` optional.
- Ohne Zugriff bleibt die Funktion aus, mit einem Hinweis im Log.

**Gelesen werden:**

- `config/device_registry/list`
- `config/entity_registry/list`
- `config/area_registry/list`
- pro zugeordnetem Gerät: `search/related` mit `item_type: device` → Automationen

**Zuordnung:** Ein HA-Gerät gehört zu einem Tasmota, wenn seine `connections` ein `mac`-Paar mit der normalisierten MAC enthalten oder seine `identifiers` `["tasmota", MAC]` sind.

**Aktualisierung:**

- beim Start, alle 5 Minuten und bei den Events `device_registry_updated`, `entity_registry_updated` und `area_registry_updated`
- Reconnect mit Backoff
- Die Daten liegen nur im Speicher.

**API-Erweiterung von `Device`:** Das Feld `ha` ist entweder `null` oder `{ deviceId, areaName, entities: [{ entityId, name }], automations: [{ id, name }] }`.

**Links in der Oberfläche:**

- Entität: `/config/entities?search=<entity_id>`
- Automation: `/config/automation/edit/<id>`
- Die Links öffnen mit `target="_top"` im HA-Hauptfenster.

## 7. Namensvorschläge

`packages/server/src/naming.ts` ist eine reine Funktion. Sie arbeitet mit Gerät, Sensoren, HA-Bereich und allen Geräten (für die Eindeutigkeit).

**Generische Namen:** leer, `Tasmota` (ohne Groß-/Kleinschreibung zu beachten), gleich dem Modulnamen, dem Muster `tasmota[_-][0-9A-F]{4,6}` oder gleich dem Hostnamen.

**Gerätetyp** (erste passende Regel gewinnt):

| Regel | Typ |
|---|---|
| Temperatur- oder Feuchte-Sensor (Schlüssel mit `Temperature`/`Humidity`, z. B. AM2301, SHT3X, BME280, DS18B20) | Klima |
| `ENERGY` und mindestens ein Relais | Steckdose |
| `ENERGY` ohne Relais | Energiezähler |
| Licht- oder Dimmer-Modul (Kanäle ≥ 1 PWM/RGB, `Dimmer` im Status) | Licht |
| genau ein Relais | Schalter |
| mehrere Relais | Schalter N-fach |
| sonst | kein Vorschlag |

**Name:** Typ und HA-Bereich, falls vorhanden, z. B. „Klima Bad“. Kollidiert der Name mit einem bestehenden Gerätenamen oder einem anderen Vorschlag, wird durchnummeriert: „Steckdose Küche 2“.

**Übernahme:** Merkt `DeviceName` und `FriendlyName1` im Puffer vor, mit `source = suggestion`. Die HA-Entitäts-IDs bleiben unverändert.

**API:** `Device` bekommt `nameSuggestion: string | null`. Ist bereits ein Name vorgemerkt, ist das Feld `null`.

## 8. Oberfläche

**Navigation:** Geräte · Ausstehend (Zähler) · Einstellungen

**Gerätetabelle:**

- **Neue Spalten:** „Entitäten“ und „Automationen“ mit allen Links als Chips direkt in der Zelle.
- **Namenszelle:**
  - Label im Warnstil (⚠-Icon und Vorschlag). Ein Klick merkt vor.
  - Punkt bei ausstehenden Änderungen.
  - Bei vorgemerktem Namen: alter Name durchgestrichen, neuer daneben.
  - Hinweis-Badge bei `SetOption4 1`.
- **Auswahlleiste:** Menü „Bearbeiten ▾“ mit *Einstellungen …*, *Befehle …* (Platzhalter `{{name}}`, `{{hostname}}`, `{{topic}}`, `{{mac}}`, `{{mac6}}`, `{{ip}}`, Vorschau pro Gerät), *Namensvorschläge übernehmen*, *Rule setzen …* und *Timer setzen …*.
- **Formular:** Nur ausgefüllte Felder werden vorgemerkt. Die Rückmeldung lautet z. B. „N Änderungen für M Geräte vorgemerkt“.

**Detailansicht mit Tabs:**

- **Info**
- **Einstellungen:** Formular mit den aktuellen Werten.
- **Rules:**
  - drei Editoren mit Syntax-Hervorhebung (`ON`, `DO`, `ENDON`, `BREAK`, `IF`/`ELSE`, `%var%`, `Var`/`Mem`)
  - Längenzähler aus `Free`/`Length` der Geräteantwort
  - Schalter an/aus
- **Timer:**
  - Formular für `Timer1`–`16`: aktiv, Modus (Uhrzeit / Sonnenaufgang / Sonnenuntergang), Zeit bzw. Versatz, Fenster, Wochentage, Wiederholen, Ausgang, Aktion
  - globaler Schalter `Timers`
  - Hinweis, wenn `Latitude`/`Longitude` fehlen und ein Sonnenmodus gewählt ist
- **Konsole:** unverändert, sofort wirksam.

**Seite „Ausstehend“:**

- gruppiert nach Gerät
- Zeilen der Form „Einstellung: vorher → nachher“, Fehler rot
- Verwerfen pro Zeile, pro Gerät oder alles
- Knopf „Batch starten (N Geräte)“
- Fortschritt pro Gerät
- „Erneut starten“ für fehlgeschlagene Einträge

**Scan-Bereiche:** Die Grenze bleibt bei /20. Die Fehlermeldung nennt den Grund und schlägt vor, die Subnetze einzeln einzutragen.

## 9. Fehlerbehandlung

- Ein Gerät bricht den Batch nie ab.
- Offline-Geräte liefern `offline`, ihre Einträge bleiben stehen.
- Die HA-API ist optional. Bei einem Fehler bleiben die Link-Spalten leer, und Vorschläge kommen ohne Bereich aus.
- `SetOption4 1` wird aus `Status 0` erkannt: `StatusLOG.SetOption[0]` ist eine Hex-Bitmaske, Bit 4 entspricht SetOption4. Das Gerät bekommt das Flag `setOption4` und einen Hinweis in der Oberfläche, und das Gateway meidet für dieses Gerät MQTT und nutzt HTTP.
- Rule-Text über dem freien Platz wird schon beim Vormerken abgelehnt (400).

## 10. Tests

**Unit:**

- Katalog: Validierung, Lesen, Reihenfolge
- Namensregeln und Nummerierung
- Puffer-Semantik: letzter Wert gilt, unveränderter Wert wird verworfen, Befehle bleiben in Reihenfolge
- Aufteilung eines Batches in Befehlsfolgen: Einstellungen mit Neustart gebündelt in einem `Backlog` am Ende, Neustart-Befehle unter den freien Befehlen erkannt
- Neustart-Erkennung: erst eine kleinere `UptimeSec` zählt, der Online-Status allein nicht; Timeout nach 90 s
- Rule/Timer-Umwandlung zwischen Formular und JSON
- Zuordnung HA-Gerät zu MAC

**Integration:**

- Das simulierte Tasmota-Gerät wird erweitert um `Status 10`, `Status 11`, `RuleN`, `TimerN`, `Timers`, `Backlog`, die Katalog-Einstellungen und `SetOption4`. Dazu kommt ein realistisches Neustart-Verhalten: Nach etwa 1 s ist das Gerät für eine einstellbare Dauer weg, bei MQTT mit LWT „Offline“ → „Online“, danach beginnt `UptimeSec` wieder bei 0.
- Getestet werden auch: mehrere MQTT-Einstellungen führen zu genau einem Neustart, und ein Gerät, das nicht zurückkommt, hinterlässt seine offenen Einträge als `offline`.
- Ein simulierter HA-WebSocket-Server liefert die Registrys, `search/related` und Events.
- Getestet wird ein kompletter Apply-Lauf über MQTT und HTTP: Neustart abwarten, Verify, fehlgeschlagene Einträge bleiben stehen.

**Frontend:**

- Klick auf das Vorschlagslabel legt einen Puffer-Eintrag an.
- Batch-Formular (nur ausgefüllte Felder), Seite „Ausstehend“ (verwerfen, starten, Fortschritt)
- Rule-Editor (Längenzähler, Ablehnung), Timer-Formular (JSON-Ergebnis)

## 11. Nicht in Plan 2

- Vorlagen und Vorlagen-Editor (entfallen vorerst)
- Job-Verlauf als eigene Seite, OTA und Backups (folgt in Plan 3)
- Scripting (Berry) und Tasmota-GPIO-Templates
