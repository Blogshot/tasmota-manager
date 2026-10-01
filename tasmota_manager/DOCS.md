# Tasmota Manager

Verwaltet alle Tasmota-Geräte im Netzwerk über eine moderne Oberfläche in der Home-Assistant-Seitenleiste.

## Geräte finden

- **MQTT:** Ist die Mosquitto-App (oder ein anderer MQTT-Dienst) in Home Assistant eingerichtet, verbindet sich die App automatisch. Geräte erscheinen über Tasmota-Discovery (`SetOption19 0`, Standard ab Tasmota 9.x).
- **HTTP:** Unter *Geräte → Netzwerk scannen* werden die in den Einstellungen hinterlegten Bereiche abgesucht (standardmäßig das Netz des Home-Assistant-Hosts). Einzelne Geräte lassen sich über *Gerät hinzufügen* per IP eintragen.

## Schalten

Geräte mit Relais oder Licht zeigen in der Spalte **Schalten** pro Ausgang einen Button mit dem aktuellen Zustand. Ein Klick schaltet sofort um. Das ist die einzige Aktion in der Tabelle, die nicht vorgemerkt wird. Bei MQTT-Geräten folgt die Anzeige auch Schaltvorgängen am Gerät oder in Home Assistant; bei reinen HTTP-Geräten erst beim nächsten Abfrageintervall.

## Passwörter

Haben Geräte ein Web-Passwort, hinterlege ein globales Passwort in den Einstellungen. Weicht ein einzelnes Gerät davon ab, setzt du das Passwort in der Detailansicht des Geräts. Geräte, die ein Passwort verlangen, erscheinen mit dem Status „Passwort erforderlich“.

## Änderungen vormerken und im Batch schreiben

Alle Änderungen an Geräten werden zuerst **vorgemerkt** und erst unter **Ausstehend → Batch starten** geschrieben:

- **Einstellungen:** Wähle Geräte in der Tabelle aus und öffne **Bearbeiten → Einstellungen …**. Nur ausgefüllte Felder werden vorgemerkt.
- **Befehle:** Unter **Bearbeiten → Befehle …** gibst du freie Tasmota-Befehle ein, mit Platzhaltern wie `{{name}}` oder `{{mac6}}`.
- **Rules und Timer:** Du setzt sie pro Gerät in der Detailansicht oder für mehrere Geräte über **Bearbeiten**.
- **Namensvorschläge:** Heißt ein Gerät nur „Tasmota“, schlägt die App anhand seiner Sensoren und seines HA-Bereichs einen Namen vor. Ein Klick auf das ⚠-Label merkt ihn vor.

Beim Batch-Lauf gilt:

- Einstellungen, die einen Neustart auslösen (MQTT), schreibt die App pro Gerät gebündelt und zuletzt.
- Danach wartet sie höchstens 90 Sekunden, bis das Gerät neu gestartet ist.
- Jeder Wert wird zurückgelesen und geprüft.
- Fehlgeschlagene Änderungen bleiben mit ihrer Fehlermeldung stehen und lassen sich erneut starten.

## Standort für Sonnenzeiten

Bei **Breitengrad** und **Längengrad** schlägt die App den Standort aus den Home-Assistant-Einstellungen vor; ein Klick übernimmt beide Werte. Über **Auf Karte wählen** öffnet sich eine Weltkarte, auf der ein Klick den Ort setzt. Die Kartenkacheln lädt der Browser von OpenStreetMap (tile.openstreetmap.org); ohne Internetzugang bleibt die Karte leer, der Vorschlag aus Home Assistant funktioniert trotzdem.

## Einstellungen je Gerätetyp

Die App erkennt aus Status und Sensoren, ob ein Gerät Energie misst, ein Licht steuert, Relais hat oder Temperatur und Feuchte misst. Das Einstellungsformular zeigt nur die passenden Gruppen: Energiemessung (PowerDelta, Nachkommastellen), Licht (Fade, Tempo, Dimmbereich, SetOption20), Relais (SetOption0, Interlock) und Klima (Nachkommastellen, °F, Korrekturwerte). Im Batch werden Einstellungen nur bei passenden Geräten vorgemerkt; die Meldung nennt übersprungene Geräte. Korrekturwerte (TempOffset, HumOffset) lassen sich nur pro Gerät setzen.

Bei der TelePeriod warnt die App unter 60 Sekunden vor einer wachsenden Home-Assistant-Datenbank. Unter 10 Sekunden bietet sie eine Regel an, die bei jeder Sensormessung sofort sendet (`ON <Sensor>#<Wert> DO TelePeriod ENDON`; `TelePeriod` ohne Argument sendet sofort, ohne das Intervall zu ändern); die Regel kommt in einen freien Rule-Slot, belegte Slots werden nie überschrieben.

## Vorschläge aus Home Assistant

Neben einigen Feldern stehen Vorschläge aus Home Assistant: Zeitzone samt Sommerzeitregeln, ein NTP-Server für dein Land, der MQTT-Broker auf dem Home-Assistant-Host, der MQTT-Benutzer deiner übrigen Geräte und die Temperatureinheit. Ein in Home Assistant vergebener Gerätename erscheint als Namensvorschlag.

## Verknüpfung mit Home Assistant

Die App liest über die Home-Assistant-API, welche Entitäten und Automationen zu einem Tasmota-Gerät gehören, und verlinkt sie in der Geräteübersicht. Den Bereich des Geräts in Home Assistant nutzt sie außerdem für Namensvorschläge. Die Entitäten-Spalte zeigt Schalter, Lichter und Sensoren; Diagnose- und Konfigurations-Entitäten sowie deaktivierte Entitäten blendet sie aus.

## Sprache

Unter **Einstellungen → Sprache** stehen Englisch, Deutsch, Französisch, Spanisch, Italienisch und Niederländisch zur Wahl. Mit **Automatisch** folgt die Oberfläche der Sprache deines Home-Assistant-Profils und die Namensvorschläge der Systemsprache von Home Assistant; ist die Sprache nicht dabei, gilt Englisch. Die Übersetzungen ins Französische, Spanische, Italienische und Niederländische sind maschinell erstellt und nicht von Muttersprachlern geprüft.

## Sicherheit

Die App braucht Host-Netzwerkzugriff, um Geräte im LAN zu erreichen. Die Oberfläche ist trotzdem nur über Home Assistant (Ingress) erreichbar. Direkte Anfragen an Port 8099 aus dem Netzwerk werden abgewiesen.
