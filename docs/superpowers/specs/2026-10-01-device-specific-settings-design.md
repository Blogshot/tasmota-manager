# Tasmota Manager – Design: Gerätespezifische Einstellungen und Vorschläge aus Home Assistant

- **Datum:** 2026-10-01
- **Status:** Entwurf zur Freigabe
- **Basis:** Version 0.3.6 (Änderungspuffer, Batch-Lauf, Einstellungskatalog, HA-Client, Standort-Vorschlag)
- **Ziel-Version:** 0.4.0

## 1. Ziel

Der Einstellungskatalog kennt bisher nur Einstellungen, die für jedes Tasmota-Gerät gelten. Dieses Vorhaben ergänzt Einstellungen für bestimmte Gerätetypen (Energiemessung, Licht, Relais, Klima), verhindert, dass sie im Batch auf unpassende Geräte geschrieben werden, und schlägt weitere Werte aus Home Assistant vor.

**Erfolgskriterien:**

- Der Nutzer wählt 12 Geräte aus, davon 7 mit Energiemessung, und setzt `PowerDelta 110`. Der Dialog zeigt „gilt für 7 von 12“. Vorgemerkt wird nur bei den 7, die Rückmeldung nennt 5 übersprungene Geräte.
- Bei einer Lampe zeigt die Detailansicht die Licht-Einstellungen, bei einer Steckdose ohne Licht nicht.
- Neben „Zeitzone“ steht „Aus Home Assistant: Europe/Berlin“. Ein Klick füllt `Timezone 99`, `TimeStd` und `TimeDst` mit den passenden Regeln.
- Ein in HA umbenanntes Gerät zeigt den HA-Namen als Namensvorschlag.

## 2. Gerätefähigkeiten

Der Server leitet pro Gerät Fähigkeiten aus dem gespeicherten Status 0 und Status 10 ab. Die Erkennung existiert bereits in `naming.ts` (Typwörter für Namensvorschläge) und wird in ein eigenes Modul `capabilities.ts` herausgelöst, das beide Stellen nutzen.

| Fähigkeit | Erkennung |
|---|---|
| `energy` | `ENERGY` in `StatusSNS` |
| `light` | `Dimmer`, `Color` oder `CT` in `StatusSTS`, oder Modulname enthält dimmer/bulb/light/led/rgb |
| `relay` | mindestens ein `POWER`/`POWERn` in `StatusSTS` |
| `multiRelay` | mindestens zwei `POWERn` |
| `climate` | Temperatur oder Feuchte in einem Sensorblock, ohne `ESP32*` und `ENERGY` (wie heute) |

- `Device` bekommt `capabilities: Capability[]`. Fehlt der Status (z. B. neues Gerät), ist die Liste leer.
- Ein Gerät ohne bekannte Fähigkeiten gilt beim Überspringen als unpassend. Der Dialog nennt solche Geräte gesondert („Typ unbekannt“), damit der Nutzer sie nicht übersieht.

## 3. Katalog

### 3.1 Neue Felder in `SettingDef`

- `appliesTo: Capability[]` – leer heißt: gilt für alle Geräte.
- `batch: boolean` – gibt es schon; `false` heißt: nur in der Detailansicht.
- `hint?: true` – das Feld hat einen erklärenden Text unter dem Eingabefeld (Wörterbuchschlüssel `hint.<Key>`).

### 3.2 Neue Einstellungen

| Gruppe | Key | Art | appliesTo | Batch | Hinweis |
|---|---|---|---|---|---|
| Energiemessung | `PowerDelta` | int 0–32000 | energy | ja | „101 = 1 W, 110 = 10 W, 1–100 = Prozent, 0 = aus“ |
| | `EnergyRes` | int 0–5 | energy | ja | |
| | `WattRes` | int 0–3 | energy | ja | |
| Licht | `Fade` | bool | light | ja | |
| | `Speed` | int 1–40 | light | ja | |
| | `DimmerRange` | „Min,Max“, je 0–100, Min < Max | light | ja | „gegen Flackern bei LED-Lampen“ |
| | `SetOption20` | bool | light | ja | „Helligkeit ändern, ohne einzuschalten“ |
| Relais | `SetOption0` | bool | relay | ja | „Schaltzustand im Flash speichern“ |
| | `Interlock` | bool | multiRelay | ja | Warnung: „Nur ein Relais gleichzeitig, z. B. für Rollläden“ |
| Klima | `TempRes`, `HumRes` | int 0–3 | climate | ja | |
| | `TempOffset` | Dezimalzahl −12,6 bis 12,6 | climate | nein | |
| | `HumOffset` | Dezimalzahl −10 bis 10 | climate | nein | |
| | `SetOption8` | bool | climate | ja | „Temperatur in °F“ |
| Zeit | `TimeStd`, `TimeDst` | Regel (s. 3.3) | alle | ja | |

`PowerDelta` wird als `PowerDelta1` geschrieben und gelesen (Tasmota indiziert es pro Kanal); der Katalog-Key bleibt `PowerDelta`.

**Hinweis bei TelePeriod:** Das Feld `TelePeriod` bekommt den Hinweis „Für schnelle Leistungswerte besser PowerDelta verwenden. Kurze Intervalle füllen die Datenbank von Home Assistant.“ Er erscheint nur, wenn mindestens ein betroffenes Gerät (in der Auswahl bzw. das Gerät selbst) die Fähigkeit `energy` hat.

### 3.3 Werteformate

- **`DimmerRange`:** Puffer- und Anzeigeformat `10,100`. Tasmota antwortet mit einem Objekt (`{"DimmerRange":{"Min":10,"Max":100}}`); der Server liest es in dieses Format.
- **`TimeStd`/`TimeDst`:** Format wie im Tasmota-Befehl: `Hemisphäre,Woche,Monat,Tag,Stunde,Versatz`, z. B. `0,0,10,1,3,60`. Tasmota antwortet mit einem Objekt mit den Feldern `Hemisphere`, `Week`, `Month`, `Day`, `Hour`, `Offset`; der Server liest es in dieses Format.
- Die genauen Antwortformate stammen aus der Tasmota-Doku, nicht aus einem Test. Das Fake-Gerät bildet sie nach; der Smoke-Test an echten Geräten (Abschnitt 8) prüft sie.

## 4. Batch: unpassende Geräte überspringen

- **Vormerken (Server):** `PendingStore.stage` merkt eine Einstellung nur bei Geräten vor, deren Fähigkeiten zu `appliesTo` passen. Das Ergebnis bekommt ein neues Feld `incompatible` (Anzahl übersprungener Geräte) neben `staged` und `skipped`.
- **Nicht im Batch:** Einstellungen mit `batch: false` lehnt der Server bei mehr als einem Gerät mit `validation` ab.
- **Dialog „Einstellungen …“:**
  - Gruppen erscheinen nur, wenn mindestens ein ausgewähltes Gerät passt.
  - Jedes Feld mit `appliesTo` zeigt „gilt für X von Y“; bei X = 0 ist es ausgegraut.
  - Nach dem Vormerken nennt die Meldung die übersprungenen Geräte.
- **Detailansicht:** Sie zeigt nur die Gruppen und Felder, die zum Gerät passen.
- **Freie Befehle, Rules, Timer:** keine Prüfung, unverändert.

## 5. Vorschläge aus Home Assistant

Alle Vorschläge erscheinen wie der Standort-Vorschlag als Label neben dem Feld. Ein Klick füllt die Felder; vorgemerkt wird erst mit „Vormerken“. Fehlt die Quelle, erscheint kein Label.

### 5.1 Datenquellen (Server)

- **HA-Konfiguration** (`get_config`, liest der HA-Client schon): `time_zone`, `country`, `unit_system.temperature`.
- **HA-Geräteregister** (liest der HA-Client schon): `name_by_user`.
- **MQTT-Dienst des Supervisors** (liest `config.ts` schon): Host und Port des Brokers.
- **Eigene LAN-Adresse:** Die App läuft mit `host_network`; der Server nimmt die IPv4-Adresse der Schnittstelle, die auch die Scan-Bereiche liefert.

Der Server bündelt das unter `GET /api/status` in einem Objekt `haSuggestions`, wie heute `haLocation`.

### 5.2 Vorschläge

| Feld | Vorschlag | Bedingung |
|---|---|---|
| Zeitzone | `Timezone 99`, `TimeStd`, `TimeDst` | HA-Zeitzone bekannt. Ohne Sommerzeit: `Timezone ±HH:MM` statt 99. |
| NTP-Server 1 | `<land>.pool.ntp.org`, sonst `pool.ntp.org` | immer |
| MQTT-Host, MQTT-Port | LAN-Adresse des HA-Hosts, Port des Brokers | Broker ist ein Dienst auf HA (Supervisor meldet `core-mosquitto` o. Ä.) und die LAN-Adresse ist bekannt |
| MQTT-Benutzer | häufigster `MqttUser` der eigenen Geräte | mindestens zwei Geräte nutzen ihn. Nie die Zugangsdaten, die der Supervisor der App gibt. |
| °F (`SetOption8`) | 1 bei `°F`, 0 bei `°C` | Feld ist sichtbar (Klima-Geräte) |
| Gerätename | `name_by_user` aus HA | gesetzt und weicht vom Tasmota-Namen ab |

### 5.3 Zeitzonen-Regeln berechnen

Ein Modul `timezone.ts` im Server rechnet eine IANA-Zone in Tasmota-Regeln um:

1. Mit `Intl.DateTimeFormat` den UTC-Versatz der Zone für jede Stunde des laufenden Jahres bestimmen und die beiden Wechsel finden.
2. Ohne Wechsel: kein `TimeStd`/`TimeDst`, Vorschlag `Timezone ±HH:MM`.
3. Mit Wechsel: Monat, Wochentag (1 = Sonntag), Woche im Monat (1–4, 0 = letzte) und lokale Stunde des Wechsels ermitteln; Versatz in Minuten. Hemisphäre 0 = Nord (Sommerzeit zwischen März und Oktober), 1 = Süd.
4. Tests mit festen Erwartungswerten für Europe/Berlin, America/New_York, Australia/Sydney und Asia/Tokyo (ohne Sommerzeit).

Die Erwartungswerte für die Tests stammen aus der Tasmota-Doku und eigenen Berechnungen; sie sind nicht an einem Gerät geprüft.

### 5.4 Gerätename aus HA

- Der HA-Client liefert pro Gerät zusätzlich `nameByUser`.
- Der Enricher schlägt diesen Namen vor, wenn er gesetzt ist und vom Tasmota-Namen abweicht. Er hat Vorrang vor dem Typwort-Vorschlag und gilt auch für Geräte mit nicht-generischem Namen.
- Ablehnen per X und „Namensvorschläge übernehmen“ funktionieren wie bisher.

## 6. Oberfläche

- Neue Gruppen im Formular: Energiemessung, Licht, Relais, Klima; `TimeStd`/`TimeDst` in der Gruppe „Zeit“.
- Hinweise (`hint.<Key>`) als kleiner Text unter dem Feld; `Interlock` als Warnung (Warnfarbe).
- „gilt für X von Y“ rechts neben dem Feldnamen im Batch-Dialog.
- Alle neuen Texte in allen sechs Wörterbüchern.

## 7. Fehlerbehandlung

- Lehnt ein Gerät eine neue Einstellung ab (ältere Firmware kennt den Befehl nicht), endet die Zeile wie bisher mit `rejected`.
- Kann der Server eine Zeitzone nicht umrechnen, erscheint kein Vorschlag; im Log steht eine Warnung.
- Fehlende Fähigkeiten: siehe Abschnitt 2.

## 8. Tests

- Unit-Tests: Fähigkeiten-Erkennung, Formate `DimmerRange` und `TimeStd`/`TimeDst` (lesen, vergleichen), Zeitzonen-Umrechnung, häufigster MQTT-Benutzer, HA-Namensvorschlag.
- Store/API: Überspringen nach Fähigkeiten, `incompatible` in der Antwort, `batch: false` bei mehreren Geräten.
- Runner mit Fake-Gerät: Schreiben und Verify für `PowerDelta`, `DimmerRange`, `TimeStd`.
- Web: gefilterte Gruppen, „gilt für X von Y“, TelePeriod-Hinweis nur bei Energiemessung, HA-Vorschläge füllen die Felder.
- **Smoke-Test an echten Geräten (Nutzer):** eine Steckdose (`PowerDelta`), eine Lampe (`DimmerRange`, `Fade`), ein Gerät mit Zeitzone aus HA. Prüft die Antwortformate aus 3.3.

## 9. Nicht Teil dieses Vorhabens

- `PowerHigh`/`MaxPower` und `PulseTime` (können Geräte abschalten).
- Rollladen-Konfiguration (`Shutter…`).
- Prüfen freier Befehle auf Gerätetyp.
- Übernahme der Zugangsdaten des MQTT-Dienstes.
