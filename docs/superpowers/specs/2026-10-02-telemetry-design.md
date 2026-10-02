# Tasmota Manager – Design: Telemetrie-Ansicht

- **Datum:** 2026-10-02
- **Status:** freigegeben im Chat (Design in vier Teilen), Spec zur Durchsicht
- **Ziel-Version:** 0.5.0 (noch nicht veröffentlicht)

## 1. Ziel

Die App zeigt die Telemetrie der Geräte: live, mit einem Verlauf der letzten Stunde. Es gibt eine Spalte „Messwerte“ in der Tabelle und einen Tab „Telemetrie“ in der Detailansicht. Ein Klick auf einen Wert zeigt sein Verlaufsdiagramm.

**Erfolgskriterien:**

- Eine Steckdose mit Energiemessung zeigt in der Tabelle z. B. „12,3 W“. Ein Klick darauf öffnet ein Diagramm der Leistung über die letzte Stunde mit Min, Max und aktuellem Wert.
- Der Tab „Telemetrie“ eines Klimasensors zeigt Temperatur und Feuchte mit Einheit und Sparkline, darunter Laufzeit und WLAN-Signal. Die Werte aktualisieren sich bei jeder Telemetrie-Nachricht.
- Ein reines HTTP-Gerät zeigt im offenen Tab alle 10 Sekunden neue Werte.

## 2. Datenquellen

| Gerät | Quelle | Takt |
|---|---|---|
| MQTT | `tele/<topic>/SENSOR`, `tele/<topic>/STATE` | jede Telemetrie-Nachricht |
| nur HTTP | vorhandene Abfrage: Status 0 (enthält `StatusSTS`) und Status 10 (`StatusSNS`) | Abfrageintervall (Standard 60 s) |
| nur HTTP, Tab offen | zusätzlich `Status 10` und `Status 11` (nur Lesen) | alle 10 s, solange der Tab offen ist |

Nichts davon schreibt auf ein Gerät.

## 3. Telemetrie-Speicher (Server, nur im Arbeitsspeicher)

- **Flachklopfen:**
  - SENSOR: `{"AM2301":{"Temperature":21.3}}` ergibt den Schlüssel `AM2301.Temperature`, Gruppe `AM2301`.
  - Arrays (Mehrkanal-Energie) ergeben `ENERGY.Power.1`, `ENERGY.Power.2`.
  - STATE ergibt die Gruppe `device`: `UptimeSec`, `Heap`, `LoadAvg`, `Sleep`, `Wifi.Signal`, `Wifi.RSSI` sowie `POWER`/`POWERn` als Text.
- **Ausgelassen:** `Time`, `TempUnit`, `PressureUnit`, `SpeedUnit`. Die Einheiten-Angaben gehen in die Einheit ein. Ebenfalls ausgelassen werden die Chip-Temperatur `ESP32*` und Textwerte in Sensorblöcken.
- **Einheiten** über eine Tabelle nach Feldname:

  | Feld | Einheit |
  |---|---|
  | Temperature, DewPoint | °C bzw. °F nach `TempUnit` |
  | Humidity | % |
  | Pressure, SeaPressure | hPa bzw. `PressureUnit` |
  | Power | W |
  | ApparentPower | VA |
  | ReactivePower | var |
  | Voltage | V |
  | Current | A |
  | Total, Today, Yesterday | kWh |
  | Frequency | Hz |
  | Illuminance | lx |
  | Distance | mm |
  | CO2, eCO2 | ppm |
  | TVOC | ppb |
  | Wifi.Signal | dBm |
  | Wifi.RSSI | % |
  | UptimeSec | s |
  | Heap | kB |
  | sonst | keine |

- **Verlauf:** Für jeden Zahlenwert gibt es einen Ringpuffer der letzten 60 Minuten. Kommen zwei Werte innerhalb von 5 Sekunden, ersetzt der neue den letzten Punkt. Höchstens 720 Punkte pro Wert.
- **Hauptwerte** für die Tabelle, höchstens zwei, in dieser Rangfolge:
  1. `ENERGY.Power` (bei Mehrkanal der erste Kanal)
  2. die erste Temperatur
  3. die erste Feuchte
  4. der erste andere Zahlenwert eines Sensorblocks

  Die Gruppe `device` zählt nie zu den Hauptwerten.
- Wird ein Gerät entfernt, löscht der Speicher auch seine Telemetrie. Nach einem Neustart der App ist der Speicher leer.

## 4. Schnittstelle

- `GET /api/devices/:id/telemetry` liefert `{ updatedAt, values, history }`:
  - `values`: Liste aus `{ key, group, name, value, unit }`
  - `history`: `{ key: [[epochMs, value], …] }`
  - Mit `?refresh=1` und einem Gerät ohne MQTT-Kanal liest der Server zuerst `Status 10` und `Status 11`. Lesefehler übergeht er und liefert den letzten Stand.
- `GET /api/telemetry` liefert die Hauptwerte aller Geräte: `{ [deviceId]: TelemetryValue[] }`.
- WebSocket-Ereignis `{ type: 'telemetry', deviceId, updatedAt, headline }` bei jeder Aktualisierung.

## 5. Oberfläche

- **Spalte „Messwerte“:**
  - Sie zeigt bis zu zwei Hauptwerte, z. B. „23,4 °C · 48 %“, und lässt sich ein- und ausblenden.
  - Jeder Wert ist ein Button. Ein Klick öffnet ein Popover mit dem Verlaufsdiagramm; die Detailansicht öffnet sich dabei nicht.
  - Ohne Werte steht „—“.
- **Diagramm** (SVG, ohne Bibliothek):
  - Linie 2 px in einem Farbton, zurückhaltende Achsen, Beschriftung „−60 min“ und „jetzt“, Min und Max an der y-Achse.
  - Eine senkrechte Hilfslinie folgt dem Zeiger und rastet am nächsten Punkt ein; ein Tooltip zeigt Uhrzeit und Wert.
  - Darunter stehen Min, Max und der aktuelle Wert als Text.
  - Mit weniger als zwei Punkten steht statt der Linie „Noch kein Verlauf“.
- **Tab „Telemetrie“:**
  - Gruppen nach Sensorblock, zuletzt „Gerät“. Jeder Wert steht mit Einheit und Sparkline (ab zwei Punkten).
  - Ein Klick auf den Wert öffnet dasselbe Diagramm.
  - Oben steht „zuletzt aktualisiert vor X s“. Ist das Gerät offline, kommt der Hinweis „offline – letzte bekannte Werte“ dazu.
  - Bei reinen HTTP-Geräten fragt der Tab alle 10 s mit `refresh=1` ab.
  - Ohne Werte steht „Noch keine Telemetrie empfangen“.
- **Texte:** Zahlen werden in der Sprache der Oberfläche formatiert, mit höchstens 2 Nachkommastellen. Alle Texte stehen in allen sechs Wörterbüchern.

## 6. Nicht Teil dieses Vorhabens

- Verlauf über einen Neustart der App hinaus oder länger als eine Stunde (dafür ist HA da).
- Telemetrie-Befehle an Geräte (TelePeriod setzen geht über die Einstellungen).
- Var/Mem-Monitor für Rules.
