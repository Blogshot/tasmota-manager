# Gerätespezifische Einstellungen – offene Nacharbeiten

Aus den Task-Reviews, dem Abschluss-Review und dessen Gegenprüfung zurückgestellte Punkte (Version 0.4.0).

## Vor dem Release an echten Geräten prüfen

- Antwortformate von `PowerDelta1`, `DimmerRange`, `TimeStd`/`TimeDst`, `TempOffset` (aus der Doku bzw. Erinnerung nachgebildet).
- Sofort-Regel `ON <Sensor>#<Wert> DO TelePeriod ENDON`: sendet `TelePeriod` ohne Argument sofort, ohne das Intervall zu ändern? Wie oft feuert der Auslöser je Sensor?
- Zeitzone aus HA (z. B. Europe/Berlin → `Timezone 99`, `TimeStd 0,0,10,1,3,60`, `TimeDst 0,0,3,1,2,120`) auf einem Gerät übernehmen und die Uhrzeit prüfen.

## Zurückgestellt aus dem Abschluss-Review

- Fast-Rule-Vorschau und -Vormerken ohne Nebenläufigkeitsgrenze (bis 500 Geräte parallel bzw. nacheinander neu gelesen).
- `timeRule`-Schema erlaubt Versatz ±9999; Tasmota begrenzt ihn vermutlich auf etwa ±780 Minuten (aus Erinnerung).
- Slot-Prüfung der Sofort-Regel berücksichtigt kein einzeln vorgemerktes `Rule<n>Enabled` und keinen freien Befehl `Rule1 …`.
- Plural-Formen bei `edit.unknownType` und `devices.stagedIncompatible` (Anzahl 1).
- `detectHostIp()` wird nur beim Start ausgewertet; nach einem IP-Wechsel bleibt der MQTT-Vorschlag bis zum Neustart veraltet.
- Die Vorschlags-Route kann theoretisch teilweise vormerken, bevor ein `StageError` auftritt (durch den 32-Zeichen-Filter praktisch ausgeschlossen).
- Der Plan `2026-10-01-device-specific-settings.md` enthält noch das alte Muster `TelePeriod 1`; Spec und DOCS sind korrigiert.

## Zurückgestellte kleinere Befunde aus den Task-Reviews

- Task 1: minor (deferred): web/src/lib/lib.test.ts doppelter Import aus @/test/fixtures; catalog.test nutzt settingDef(...)! statt def()-Helfer; kein RED-Lauf dokumentiert
- Task 2: minor (deferred): nameByUser '' statt null bei leerem name_by_user (|| null); raw.get doppelt in enrich; keine Tests für CT/Color-Licht und Modul-Negativfall
- Task 3: minor (deferred): Runner-Test prüft nicht direkt die Werte im Fake; valuesEqual decimal/dimmerRange: '' == '0'
- Task 4: minor (deferred): API-Testtitel nennt Ablehnung mehrerer Geräte, prüft sie aber nicht über die Route (plan-mandated Titel); perDevice zählt doppelte IDs
- Task 5: minor (deferred): Woche aus einem Jahr abgeleitet (Chatham), Minuten der Wechselstunde verworfen (Tasmota nur ganze Stunden)
- Task 5: minor (deferred): Asia/Jerusalem kippt zwischen Woche 0/4 je nach Jahr (konservativ null); Memo-Cache unbegrenzt bei beliebigen Zonen-Strings
- Task 6: minor (deferred): unbekannte Geräte-ID ohne Eintrag; stage meldet keine Gründe; Tests für noSensors/Slot 2/omitted über API fehlen; Sensornamen mit Sonderzeichen ungeprüft
- Task 6: minor (deferred): spy.mockRestore nicht in finally; catch-all meldet auch Programmierfehler als unreachable
- Task 7: minor (deferred): Credential-Test prüft ohne MQTT-Konfiguration (plan-mandated, Name übertreibt); onHa im Supervisor-Mock irreführend; Glue in server.ts ungetestet
- Task 8: minor (deferred): fehlende Tests (Hints/Interlock-Farbe, unknown-type-Hinweis, stagedIncompatible-Toast, 10–60 s, Einzelgerät ohne „gilt für“, Lampe-Warnung positiv); "0" zeigt Regelangebot
- Task 9: minor (deferred): LedState-Negativtest synchron (vor Query-Auflösung); keine Tests für visibleKeys-Filter, null-Quellen, SetOption8/MqttUser
- Task 10: minor (deferred): kein Fehlerzustand bei fehlgeschlagener Vorschau (bleibt bei „wird erstellt …“); gecachte Vorschau blitzt beim Wiederöffnen; Tests nur ok/noSensors; Toast zählt Einträge statt Geräte
- Task 11: minor (deferred): DOCS nennt nicht, dass die Sofort-Regel auch TelePeriod 10 und RuleNEnabled vormerkt und ENERGY/ESP32 auslässt

## Getroffene Entscheidungen

- Ruling R1: T1 hält den ganzen Workspace kompilierbar mit neutralen Werten (store/suggestions liefern incompatible: 0, live.ts liefert Default-haSuggestions, toDevice capabilities: [], HaClient nameByUser: null, Web-Fixtures ergänzt); T2/T4/T7 ersetzen sie durch echte Logik — Plan verlangt in T2 grünen Typecheck — kostet wenn falsch: kleine Doppelarbeit in T2/T4/T7
- Task 6: review: 1 Important (Slot-Wahl ignoriert vorgemerkte Rule<n> → überschreibt Puffer), dazu Ruling: per-Gerät-Lesefehler → 'unreachable' statt 500 für alle (Review-Focus: andere Geräte nicht abbrechen) — kostet wenn falsch: nichts; fix round 1 an Implementer
- Task 8: Ruling: Felder mit X = 0 werden ausgeblendet statt ausgegraut (Spec §4 sagt ausgegraut, Plan-Code blendet aus) — innerhalb sichtbarer Gruppen betrifft das nur z. B. Interlock bei Einzelrelais; Ausblenden ist klarer — kostet wenn falsch: Filter in SettingsFields.tsx:60 auf disabled umstellen
- Ruling: Sofort-Regel nutzt `TelePeriod` ohne Argument statt `TelePeriod 1` — CmndTeleperiod setzt bei Payload 1 tele_period auf TELE_PERIOD (300), ohne Argument nur den Zähler (sendet sofort); deckt sich mit Reviewer und eigener Erinnerung, widerspricht der Angabe des Nutzers („TelePeriod 1 löst Send aus“ – stimmt, setzt aber zusätzlich zurück) — kostet wenn falsch: Regel löst keine Sofortmeldung aus; Smoke-Test prüft es; Nutzer wird informiert
- Ruling: in die Fix-Welle zusätzlich: Vorschau-Fehlerzustand (T10), Credential-Test mit onHa+Passwort (T7), T4-Testtitel/Route-Assertion, Log-Warnung je Zone (Spec §7), DVES_USER und Dienst-Benutzer nicht vorschlagen, kein MQTT-Vorschlag bei mqtts, Hinweis bei unbekanntem Typ auch in der Detailansicht, Offset-Label mit Punkt — billig und nutzersichtbar
- Ruling: zurückgestellt: Nebenläufigkeitsgrenze Fast-Rule (Minor 1), timeRule-Offset-Grenze ±780 (aus Erinnerung, unsicher), Slot-Check für Rule<n>Enabled/freie Befehle, Plural-Formen
- Final: parked — detectHostIp() nur beim Start ausgewertet (MQTT-Vorschlag veraltet nach IP-Wechsel bis Neustart) — Ruling: real, aber selten; deferred
- Final: parked — alter Plan enthält noch `TelePeriod 1` — Ruling: historisches Dokument, Spec und DOCS sind korrigiert
- Final: parked — Vorschlags-Route kann theoretisch teilweise vormerken vor einem StageError — Ruling: durch 32-Zeichen-Filter praktisch ausgeschlossen; deferred
