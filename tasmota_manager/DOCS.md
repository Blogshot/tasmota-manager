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

## Verknüpfung mit Home Assistant

Die App liest über die Home-Assistant-API, welche Entitäten und Automationen zu einem Tasmota-Gerät gehören, und verlinkt sie in der Geräteübersicht. Den Bereich des Geräts in Home Assistant nutzt sie außerdem für Namensvorschläge. Die Entitäten-Spalte zeigt Schalter, Lichter und Sensoren; Diagnose- und Konfigurations-Entitäten sowie deaktivierte Entitäten blendet sie aus.

## Sprache

Unter **Einstellungen → Sprache** stehen Englisch, Deutsch, Französisch, Spanisch, Italienisch und Niederländisch zur Wahl. Mit **Automatisch** folgt die Oberfläche der Sprache deines Home-Assistant-Profils und die Namensvorschläge der Systemsprache von Home Assistant; ist die Sprache nicht dabei, gilt Englisch. Die Übersetzungen ins Französische, Spanische, Italienische und Niederländische sind maschinell erstellt und nicht von Muttersprachlern geprüft.

## Sicherheit

Die App braucht Host-Netzwerkzugriff, um Geräte im LAN zu erreichen. Die Oberfläche ist trotzdem nur über Home Assistant (Ingress) erreichbar. Direkte Anfragen an Port 8099 aus dem Netzwerk werden abgewiesen.
