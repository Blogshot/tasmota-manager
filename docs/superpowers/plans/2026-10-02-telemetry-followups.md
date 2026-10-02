# Telemetrie und 0.5.0 – offene Nacharbeiten

Aus den Task-Reviews, dem Abschluss-Review und dessen Gegenprüfung zurückgestellte Punkte (Version 0.5.0: aktuelle Werte in der Detailansicht, veraltete Geräte, Mehrfach-Entfernen, Telemetrie).

## Im Browser bzw. am Gerät prüfen

- Breite des Diagramm-Popovers in der Tabelle, Marker und Achsen im Dark Mode.
- Telemetrie eines reinen HTTP-Geräts im offenen Tab (alle 10 s, keine Anfragenhäufung).
- Einheiten echter Sensoren (u. a. SR04 in cm, VL53L0X in mm – aus Erinnerung an die Firmware).

## Zurückgestellt aus dem Abschluss-Review

- Ein Gerät ohne `lastSeen` (z. B. aus einer alten Discovery-Nachricht bei LWT Offline) gilt sofort als veraltet; `createdAt` steht im Gerätemodell nicht zur Verfügung.
- Sparklines zeigen die ganze gespeicherte Spanne, nicht nur 60 Minuten; Werte, die nicht mehr gemeldet werden, bleiben im Speicher stehen.
- Ein Ladespinner je Feld ist jeweils eine eigene Live-Region (Screenreader).
- Plural-Formen bei Anzahl 1 („1 Geräte“).
- Bei MQTT-Geräten lädt ein offener Tab oder Popover bei jeder Telemetrie-Nachricht den ganzen Verlauf neu (bis ca. 200 KB); ggf. drosseln.
- `api.setting` bzw. `GET /api/devices/:id/settings/:key` wird nur noch von der Seite „Ausstehend“ genutzt.

## Zurückgestellte kleinere Befunde aus den Task-Reviews

- Task 1: minor (deferred): abgelegte Punkte können <5 s auseinanderliegen (Ersetzen bis 5 s nach vorletztem, plan-mandated; Grenzen 720/60 min halten); leerer Geräteeintrag bei unbrauchbarer Nutzlast; verschwundene Sensorwerte bleiben stehen; summary() schwach typisiert; FIXED_UNITS nicht auf ENERGY beschränkt; fehlende Tests TempUnit F/PressureUnit/Heap/Sleep
- Task 2: minor (deferred): Refresh-Route kann nach gleichzeitigem Löschen einen Eintrag neu anlegen (registry.get vor record prüfen); identify/poller-Pfad ohne Test; zwei sequenzielle Abfragen verdoppeln Timeout bei nicht erreichbarem Gerät
- Task 3: minor (deferred): Tooltip nur per Zeiger (keine Tastatur), verschwindet bei Touch nach dem Loslassen; nl „verloop“ statt „geschiedenis“; Marker im Dark Mode visuell prüfen
- Task 3: minor (deferred): Fenster rückt nur bei Neu-Rendern vor (kein Timer); y-Labels können frühe Linie überdecken; Min=Max doppelt beschriftet
- Task 4: minor (deferred): live.ts-Fall 'telemetry' ohne Test; kein Test für zwei Werte/Klick im Popover-Inhalt; „—“ ohne muted-Stil; Diagramm ohne Ladezustand (zeigt kurz „Noch kein Verlauf“)
- Task 5: minor (deferred): 1-s-Takt rendert ganzen Tab neu; kein Lade-/Fehlerzustand; überflüssiges stopPropagation; Tests für 10-s-Intervall/Kopfzeile fehlen; doppelte Anführungszeichen in neuen Wörterbucheinträgen; Importposition in DeviceSheet

## Getroffene Entscheidungen

- Task 3: Ruling: festes Zeitfenster [jetzt−60 min, jetzt] mit optionalem now-Prop, ältere Punkte ausblenden, y-Achsen-Beschriftung Min/Max ergänzen, Snap-Test mit gestubbtem Rect — Spec §5 verlangt beides — kostet wenn falsch: kurze Verläufe erscheinen schmal am rechten Rand
- Task 6: Ruling: Task-Review in das Abschluss-Review gelegt — 6 Zeilen Doku, wörtlich aus dem Plan an den genannten Stellen (vom Controller per Diff geprüft) — kostet wenn falsch: ein Doku-Satz muss nachgezogen werden
- Ruling: Abschluss-Review umfasst den ganzen Branch seit main (inkl. ec237f6 aktuelle Werte und dce26ee veraltet/Mehrfach-Entfernen, die ohne Subagent-Review entstanden sind)
- User decision: Telemetrie-Feldnamen bleiben im Tasmota-Original (keine Übersetzung) — nicht in die Fix-Welle aufnehmen
- Ruling: Fix-Welle: getrennte Query-Keys für Abfrage-Modus (WS invalidiert nur den Live-Key), Verdichtung gegen den letzten Punkt, Sammel-Endpunkt liest fehlende Einstellungen nacheinander und nur bei Online-Geräten nach geladenem Status; dazu Minor: updatedAt ohne Verlaufskopie, Teilfehler beim Mehrfach-Entfernen, SR04-Abstand in cm und Sleep in ms, aria-label für Messwert-Buttons — kostet wenn falsch: Felder füllen sich gesammelt statt einzeln
- Ruling: zurückgestellt: lastSeen null sofort veraltet (createdAt nicht im Gerätemodell), Sparkline nicht auf 60 min gefiltert, eine Live-Region je Feld, Plural-Formen, Throttle der Historien-Neuladung
- Ruling: Fix-Welle Punkt 3 — Lesen startet bei status !== undefined (geladen, auch null ohne gespeicherten Status) statt bei nicht-null; Brief-Bedingung hätte Geräte ohne Status 0 nie gelesen — kostet wenn falsch: nichts
