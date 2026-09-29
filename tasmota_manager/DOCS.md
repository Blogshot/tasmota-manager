# Tasmota Manager

Verwaltet alle Tasmota-Geräte im Netzwerk über eine moderne Oberfläche in der Home-Assistant-Seitenleiste.

## Geräte finden

- **MQTT:** Ist die Mosquitto-App (oder ein anderer MQTT-Dienst) in Home Assistant eingerichtet, verbindet sich die App automatisch. Geräte erscheinen über Tasmota-Discovery (`SetOption19 0`, Standard ab Tasmota 9.x).
- **HTTP:** Unter *Geräte → Netzwerk scannen* werden die in den Einstellungen hinterlegten Bereiche abgesucht (standardmäßig das Netz des Home-Assistant-Hosts). Einzelne Geräte lassen sich über *Gerät hinzufügen* per IP eintragen.

## Passwörter

Haben Geräte ein Web-Passwort, hinterlege ein globales Passwort in den Einstellungen. Weicht ein einzelnes Gerät davon ab, setzt du das Passwort in der Detailansicht des Geräts. Geräte, die ein Passwort verlangen, erscheinen mit dem Status „Passwort erforderlich“.

## Sicherheit

Die App braucht Host-Netzwerkzugriff, um Geräte im LAN zu erreichen. Die Oberfläche ist trotzdem nur über Home Assistant (Ingress) erreichbar. Direkte Anfragen an Port 8099 aus dem Netzwerk werden abgewiesen.
