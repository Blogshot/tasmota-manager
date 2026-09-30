# Plan 2 – offene Nacharbeiten

Aus den Task-Reviews, dem Abschluss-Review und dessen Gegenprüfung von Plan 2 zurückgestellte Punkte. Sie sind für Plan 3 oder einen Aufräum-Durchgang gedacht.

## Vor dem ersten Einsatz an echter Hardware prüfen

Alle Tests laufen gegen ein Fake-Gerät, dessen Verhalten aus der Erinnerung an den Tasmota-Quelltext nachgebaut ist. Ein Batch-Lauf an einem echten Gerät sollte abdecken:

- Zeitzone (`+01:00`, zusätzlich `+08:00` – siehe Verdacht unten)
- einen Sonnenaufgangs-Timer mit positivem Versatz
- `LedState` zusammen mit `LedPower`
- eine Rule
- ein MQTT-Bündel (Host, Benutzer, Passwort, Topic)

**Unbelegter Verdacht:** Tasmota liest Zahlen mit automatischer Basis (`strtol(…, 0)`). `Timezone +08:00` und `+09:00` könnten deshalb als ungültiges Oktal zu `+00:00` werden. Der Verify würde die Abweichung melden, das Gerät stünde aber auf UTC; die Feldbeschriftung schlägt genau dieses Format vor. Falls bestätigt: beim Senden führende Nullen der Stunden entfernen (`+8:00`).

## Abweichungen von der Spec (§5), im Abschluss-Review entstanden

- Ein gesendeter freier Befehl wird sofort aus dem Puffer genommen. Das gilt auch für Neustart-Befehle (`Restart 1`, `SSId1 …`), wenn das Gerät danach nicht zurückkommt: Das Gerät steht im Job als fehlgeschlagen, die noch nicht gesendeten Zeilen bleiben stehen. „Offene Einträge“ heißt damit „noch nicht gesendete“.
- „Folgebefehle versuchen es 90 s lang erneut“ gilt für nicht idempotente freie Befehle nur, wenn der Fehler sicher „nicht ausgeführt“ bedeutet (Verbindung kam nie zustande). Bei Abbruch nach dem Senden, HTTP-Fehlerstatus, unlesbarer Antwort oder Timeout endet die Zeile mit Fehler. Einstellungen und Abfragen werden wie bisher wiederholt.
- Timer: Eine Uhrzeit mit `-` und ein Sonnen-Versatz ab 12 h werden beim Vormerken abgelehnt, weil die Firmware daraus eine andere Zeit macht.
- Neustart gilt auch nach beobachteter Nichterreichbarkeit als erfolgt (nicht nur bei kleinerer Uptime); Neustart-Einstellungen werden immer verifiziert, auch ohne IP.

## Zurückgestellte Befunde aus dem Abschluss-Review

- „Neustart“-Befehle, die nicht neu starten (`Topic`/`FullTopic` mit unverändertem Wert, vermutlich `IPAddress1-4`), enden nach 90 s als `offline`, obwohl das Gerät antwortet. Idee: bei durchgehend erreichbarem Gerät mit steigender Uptime nach ca. 20 s als „kein Neustart“ werten.
- `LedState` und `LedPower` zusammen vorgemerkt: `LedPower` überschreibt `LedState` auf dem Gerät, Verify meldet dann eine Abweichung.
- `0` und `1` sind bei Tasmota-Texteinstellungen Sonderwerte (`LogHost 0` löscht, `1` setzt auf Standard) – führt zu falscher Abweichung bzw. stillem Zurücksetzen.
- Ein vorgemerkter Wert, der dem veralteten gespeicherten Status entspricht, wird als „bereits aktuell“ verworfen (MQTT-Geräte aktualisieren den Status nur bei LWT/Discovery und nach einem Batch).
- Offline-Geräte belegen 90 s lang einen Worker, bevor sie scheitern.
- Der letzte Job bleibt auf „Ausstehend“ dauerhaft stehen (nicht ausblendbar).
- Detail-Tabs (Rules, Timer, Einstellungen) zeigen Gerätewerte, nie vorgemerkte; die Queries werden bei `job:done` nicht invalidiert.
- Das Bearbeiten-Menü wirkt auch auf ausgewählte Geräte, die der aktuelle Filter ausblendet.
- Der Batch-Rule-Dialog merkt auch einen leeren Text vor (leert den Rule-Slot auf allen ausgewählten Geräten) – Bestätigung fehlt.
- `apply.onSuccess` kann neueren Fortschritt kurz mit dem Start-Snapshot überschreiben.
- Kein Log-Hinweis, wenn der HA-Zugriff nicht konfiguriert ist (Spec §6); Sonnen-Hinweis im Timer-Formular erscheint immer statt nur ohne Standort (Spec §8).
- HA-Links enthalten deaktivierte Entitäten.
- `enricher.one()` berechnet bei jedem Registry-Update alle Geräte neu.

## Zurückgestellte Befunde aus der Gegenprüfung der Fixes

- Weitere Befehle mit Zugangsdaten bleiben in „Ausstehend“ sichtbar: `WebSend [host,user:pass] …`, `OtaUrl http://user:pass@…`, `Rule1 ON … DO WebPassword x ENDON` (auch als Rule-Einstellung).
- Ein MQTT-Publish-Fehler weicht bei Nicht-Abfragen nicht mehr auf HTTP aus (betrifft auch die Konsole).
- Timer-Formular: Eine Uhrzeit ab 12 h bleibt beim Wechsel auf Sonnenmodus stehen und scheitert nur mit der generischen Meldung.
- Mehrdeutig gescheiterte freie Befehle lassen sich blind wiederholen; die Fehlermeldung sagt nicht „möglicherweise bereits ausgeführt“.
- Das Zeitzonen-Schema lässt nicht darstellbare Werte zu (`-00:30`, `+05:75`, `25`).
- `job_items.changeIds` enthält sofort aufgelöste Befehle nicht mehr – für den Job-Verlauf in Plan 3 beachten.
- Der alte Test „meldet unreachable bei geschlossenem Port“ nutzt Port 1, den `fetch` selbst blockiert.
- `runSafe` (unerwartete Ausnahme im Gerätelauf) vermerkt Fehler ohne Wert-Prüfung.
- Restrisiko: Bricht die App genau während des Sendens eines freien Befehls ab, bleibt die Zeile als unterbrochen stehen, obwohl das Gerät ihn eventuell ausgeführt hat.

## Zurückgestellte kleinere Befunde aus den Task-Reviews

Durch die Fix-Runde nach dem Abschluss-Review erledigt: Timer-Vorzeichen (Task 1, Task 16), Ergebnisse erst am Ende des Gerätelaufs gespeichert (Task 8), Fehler eines alten Werts an neu vorgemerkter Zeile (Task 8), Test der Start-Recovery (Task 11).

- Task 1: minor (deferred): int accepts leading zeros; Timezone regex accepts 25; Timer Time sign in all modes; thin catalog test coverage
- Task 2: minor (deferred): duplicate import from ./tasmota/parse in registry.ts; hasSetOption4/getSensors edge tests
- Task 3: minor (deferred): findEntry startsWith fallback too broad (use ^key\d+$); coord ''==0; null Length/Free; coverage gaps
- Task 4: minor (deferred): stage comment wording; redundant changed events; rows() loads whole table / getStatus per row; tests for no-event-on-failure, multi-device rollback, invalid password message
- Task 5: minor (deferred): exact uptime assertions may flake under load; no test for mqttDiscovery sensors path + silent Status 10 failure; extra sequential MQTT round-trip; dead RESTART_KEYS (TOPIC, HOSTNAME)
- Task 6: minor (deferred): setting rows with unknown catalog key are silently dropped from the plan (runner never resolves/fails them); no tests for bundle-only / write-only-only plans
- Task 7: minor (deferred): deadline overshoot by one poll/timeout; Number() coercion in uptime; missing tests (timeout+idempotent retry, offline retry, deadline give-up, query single attempt)
- Task 8: minor (deferred): verify aborts on rejected read; refreshStatus swallows silently; JobRepo writes without transaction; results persisted only at end of device run (interrupted run re-executes free commands on retry); extra progress event after verify; multi-device/concurrency tests
- Task 8: minor (deferred): failure of an old value can be attached to a re-staged row (no value guard in fail path)
- Task 9: minor (deferred): start() twice opens second socket; no keepalive/ping; overlapping refresh calls; warn every 5 min while disconnected; sequential search/related
- Task 9: minor (deferred): auth_ok resets backoff to 1000 instead of reconnectMs; HaResultError tolerance path untested; no guard against concurrent refresh
- Task 10: minor (deferred): /led/ module regex too broad; suffix reserve only 3 chars; test gaps (truncation, numbering >2, module-based light); one() recomputes all
- Task 11: minor (deferred): startup recovery wiring untested at server level; 409 tested for one route only; suggestions route doesn't catch StageError; staging allowed during a running batch (runner tolerates via resolveUnchanged); 16 sequential sends for timers; parse errors → 500
- Task 12: minor (deferred): devices:stale and job:progress fallback untested; useStage untested; RED run skipped by implementer (tests judged non-vacuous by reviewer)
- Task 13: minor (deferred): pending dot lacks accessible name; no visual cue between old and pending name; extra coverage (pending button state, error toast)
- Task 14: minor (deferred): stale validation errors when reopening settings dialog; no pending guard on suggestions; test gaps (unknown placeholder, nothing entered, none-toast)
- Task 15: minor (deferred): no tests for timer entry, discard device/all, nav badge; progressbar lacks accessible name
- Task 16: minor (deferred): inconsistent dialog reset after staging (rule clears text, timer keeps all); error-path tests (too long rule, invalid timer, disabled rule); mode switch keeps Time format; Number('') → 0 for window/output
- Task 17: minor (deferred): test gaps (timer read error, nothing-changed toast, rule text edit, max length); TabsList height with wrap on narrow sheets; bare "…" loading text

## Getroffene Entscheidungen

- Task 1: Ruling: accept plan-mandated finding — renderPlaceholders/STATUS_READERS must ignore prototype keys (Object.hasOwn) — user input reaches devices; cost: none
- Task 5: Ruling: plan-mandated finding "fake multi-relay Power handling broken" NOT fixed now — `relays` in the fake only feeds StatusSTS for name suggestions; no task switches POWERn on multi-relay fakes — cost if wrong: a later multi-relay power test fails and the fake needs a small fix
- Task 7: Ruling: accept plan-mandated finding — waitForRestart must only swallow transient TransportErrors (unreachable/offline/timeout) and rethrow everything else — real errors must not surface as "offline" after 90 s
- Task 7: Ruling: promote minor "missed restart on a young device" and amend plan clarification #2: a restart also counts when the device was unreachable during the wait and answers again — needed because our own flow can restart a device twice in a row (uptimeBefore ≈ 0 then never "smaller") — cost if wrong: a transient network drop during the wait counts as restart; verify still checks the values
- Task 8: Ruling: accept plan-mandated finding 1 — progress/emit must never throw, runSafe catch guarded, job always finished after all workers settled — single-batch guarantee is a global constraint
- Task 8: Ruling: accept plan-mandated finding 2 — resolve only rows whose value is unchanged since planning (re-staged values stay in the buffer) — spec "letzter Wert gilt" must not lose a newer value
- Task 8: Ruling: accept plan-mandated finding 3 and amend spec §5 — restart settings are verified whenever the device came back, also without IP (no skip) — if the device moved to another broker and has no IP, waitForRestart already fails as offline; cost if wrong: verify over MQTT times out → entry marked failed instead of silently resolved
- Task 8: Ruling: also fix minors 1-4 in the same round (dedupe deviceIds, clamp concurrency ≥1, fail rows not covered by the plan, only a rejected *send* is non-aborting)
- Task 9: Ruling: accept plan-mandated findings 1-4 (interval leak after stop, partial snapshot on failed search/related, synchronous throw on bad URL, invalid-token test can't fail) plus tests for reconnect-after-drop and stop cleanup — HA link is optional and must never crash or corrupt data; ws ^8.22.0 accepted (pnpm add resolved latest 8.x)
- Task 10: Ruling: promote minor "internal ESP32 temperature counts as climate sensor" to a fix — every ESP32 reports StatusSNS.ESP32.Temperature and would be suggested as "Klima"; ignore ESP32* and ENERGY blocks for the climate rule — cost if wrong: none
- Task 15: Ruling: accept deviation `useQuery<RuleState[] | TimersState>` (tsc union queryFn) — type-only
- Task 17: Ruling: accept plan-mandated finding — DeviceDetail must remount per device (key={deviceId}) so Rule/Timer/Settings form state can never be staged onto another device — cost: none
- Abschluss-Review: Ruling: Important 1–4 plus zwei Begleitpunkte in einer Fix-Runde behoben; die 13 Minors bleiben zurückgestellt
- Abschluss-Review: Ruling: Befund der Gegenprüfung (Passwort-Maskierung umgehbar über Index, `=`, Topic-Präfix) direkt behoben; ihre Minors bleiben zurückgestellt
- Ruling: CI-Workflow auf den Forgejo-Runner umgestellt (`.forgejo/workflows/ci.yml`, `runs-on: swarm-manager`, Test-Job in `node:22`), kein `pull_request`-Trigger
