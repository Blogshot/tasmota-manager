# Changelog

## 0.5.1

- Home Assistant links: if Home Assistant lists several devices with the same MAC address (for example the Tasmota device and a network tracker from UniFi or a FRITZ!Box), the app now links the Tasmota device, so its automations, entities and area show up again.
- Telemetry tab: values now come first and the sparklines sit in a fixed column on the right, so values and sparklines line up across rows.

## 0.5.0

- Telemetry: a new "Readings" column shows each device's main values (power, temperature, humidity), and a click opens a chart of the last hour. The new "Telemetry" tab in the device details shows all sensor and device values live, with sparklines. History is kept in memory for one hour and starts empty after an app restart.
- Remove several devices at once: select them in the table and click "Remove". Only the entries in the app are removed; nothing changes on the devices.
- Devices that Home Assistant does not know and that have not been seen for more than 7 days are marked as "stale", and the status filter can show only those, so leftovers and duplicates are easy to clean up.
- Device details: empty settings fields now show the device's current value instead of "unchanged". Values that are not part of the stored status are read from the device, with a small loading spinner while that happens. Leaving a field empty still means "don't change".

## 0.4.0

- Device-type specific settings: energy monitoring (PowerDelta, decimals), lights (fade, speed, dimmer range, SetOption20), relays (SetOption0, interlock) and climate sensors (decimals, °F, offsets).
- Batch edits only apply settings to devices of the matching type; the confirmation names skipped devices.
- Warning for short telemetry intervals, and a generated rule for instant updates on every sensor reading when you need faster than 10 s.
- Suggestions from Home Assistant: timezone with daylight saving rules, NTP server for your country, MQTT broker on the Home Assistant host, the MQTT user of your other devices, temperature unit, and device names you set in Home Assistant.

## 0.3.6

- Updates are now delivered as ready-made images for amd64 and aarch64. Home Assistant only downloads the image instead of building the app on your device, so updates are much faster and show download progress.

## 0.3.5

- Fixed: the map picker showed "Access blocked" instead of the map. OpenStreetMap rejects tile requests without a referrer, and Home Assistant suppresses it; the map now sends the origin of your Home Assistant address.
- Faster updates: the app image no longer installs a compiler toolchain and skips the type check during the build. On a fast x86 machine the build time dropped from about 45 to about 22 seconds.

## 0.3.4

- Latitude and longitude: the location from your Home Assistant settings is suggested next to the fields and can be applied with one click.
- New map picker: open a world map, drag and zoom, and click to set the location. Map tiles are loaded from OpenStreetMap.
- Name suggestions can be dismissed with the small red "X" in the label. A dismissed suggestion is no longer shown or applied; the confirmation offers "Undo".
- Pending changes: unknown old values (e.g. telemetry interval, timezone, location, SetOptions, rules, timers) are now read live from the device, so you see the actual change.

## 0.3.1

- Entity labels now open the device page in Home Assistant. The entity list cannot be pre-filtered by URL, so the old links showed an unfiltered list.
- The entity column shows at most three entities; the rest are behind a "…" button.

## 0.3.0

- Language selection in the settings: English, German, French, Spanish, Italian and Dutch. "Automatic" follows your Home Assistant profile and falls back to English. French, Spanish, Italian and Dutch are machine-translated.
- Name suggestions use the selected language.
- New "Switch" column: one button per relay or light shows the current state and toggles it right away.
- The entity column hides diagnostic, configuration and disabled entities.
- Error messages are translated in the interface.

## 0.2.1

- Fixed: names, status and sensors of MQTT devices were never refreshed (for example after a rename in a batch run).
- Fixed: drop-down lists were unreadable in dark mode.

## 0.2.0

- Changes are staged first and only written to the devices when you start the batch run.
- Batch editing of settings, free commands, rules and timers for several devices.
- Safe batch runs: restart settings are bundled per device, the app waits for the restart and verifies every value.
- Name suggestions for devices still called "Tasmota", based on sensors and the Home Assistant area.
- Links to Home Assistant entities and automations.
- Rules and timers editor in the device details.

## 0.1.0

- First release: device discovery via MQTT and network scan, device overview, device details with console, tags and per-device passwords.
