# Tasmota Manager – Hinweise für Claude

Home-Assistant-App (früher „Add-on“) zur Verwaltung und Batch-Konfiguration aller Tasmota-Geräte im LAN, ähnlich TasmoAdmin, mit moderner Oberfläche.

## Kommunikation

- Mit dem Nutzer auf Deutsch, mit korrekten Umlauten. Commit-Nachrichten auf Deutsch.
- Öffentliche Texte (README, CHANGELOG, Forenbeiträge) auf Englisch. `DOCS.md` ist deutsch.

## Grundregel: Änderungen werden vorgemerkt

„Umsetzen“, „übernehmen“ o. Ä. heißt: Jede Änderung an einem Tasmota-Gerät landet zuerst im Änderungspuffer (`pending_changes`) und wird erst geschrieben, wenn der Nutzer den Batch-Lauf startet. Neue Funktionen, die Geräte verändern, laufen über Puffer und `ApplyRunner`, nicht über direkte Befehle.

Bewusste Ausnahmen, die sofort wirken: Schalten (Relais-Buttons, Toggle), Neustart und freie Befehle in der Konsole, Tags und Passwort pro Gerät. Reine Abfragen (Status, Rules, Timer, einzelne Einstellungen lesen) sind jederzeit erlaubt. Im Zweifel nachfragen.

## Aufbau

- Repo-Wurzel = HA-App-Repository (`repository.yaml`). Der Supervisor baut lokal, Build-Kontext ist der App-Ordner, deshalb liegt das Monorepo in `tasmota_manager/`.
- `tasmota_manager/config.yaml`: Version, Ingress (Port 8099), `host_network`, `mqtt:want`, `homeassistant_api`.
- pnpm-Workspace (pnpm 10, TypeScript strict, ESM):
  - `packages/shared`: zod-Schemas, Typen, Einstellungskatalog (`catalog.ts`: `SETTINGS`, `issue()` für Validierungsschlüssel), Sprachen (`LANGUAGES`, `resolveLanguage`).
  - `packages/server`: Fastify 5, better-sqlite3 + Drizzle (Migrationen in `drizzle/`, erzeugen mit `pnpm db:generate --name <name>`), mqtt.js, HA-WebSocket-Client.
  - `packages/web`: React 19, Vite, Tailwind 4, shadcn/ui (radix), TanStack Query/Table, Leaflet (lazy geladen).
- Wichtige Server-Bausteine: `DeviceRegistry` (MAC als ID), `DeviceGateway` (MQTT bevorzugt, HTTP als Rückfall, nur sicher wiederholbare Fallbacks), `PendingStore`, `ApplyRunner`, `DeviceOps`, `HaClient`, `DeviceEnricher`, `naming.ts`.

## Befehle

```bash
cd tasmota_manager
pnpm install
pnpm typecheck
pnpm test
pnpm build
docker build -t tasmota-manager:dev tasmota_manager   # aus der Repo-Wurzel
```

## Konventionen im Code

- Testgetrieben arbeiten (erst fehlschlagender Test). Das Fake-Gerät (`server/test/fakes/fakeTasmota.ts`) muss sich wie echte Firmware verhalten, nicht wie die App es erwartet. Beispiel: `Status 0` kommt per MQTT als eine Nachricht pro Block (`STATUS`, `STATUS1` … `STATUS11`).
- Oberflächentexte nur über Schlüssel. Jede neue Taste gehört in alle sechs Wörterbücher: `web/src/lib/messages.ts` (de, en) und `web/src/lib/locales/{fr,es,it,nl}.ts`. Ein Test prüft Vollständigkeit und Platzhalter.
- Fehler vom Server: Code plus englischer Rohtext (`timeout: …`, `verify_mismatch: expected "x", got "y"`). Validierungstexte als Schlüssel (`invalid.range|0|5`). Übersetzt wird in `web/src/lib/errors.ts`.
- Passwörter nie in API-Antworten oder Logs; freie Befehle mit Passwörtern werden in `GET /api/changes` maskiert.
- Firmware-Verhalten, das nur aus der Erinnerung stammt, als solches kennzeichnen.

## Arbeitsweise

- Größere Vorhaben: superpowers-Skills (brainstorming → Spec in `docs/superpowers/specs/` → Plan in `docs/superpowers/plans/` → subagent-driven-development). Kleinere, abgegrenzte Änderungen: kurzes Design im Chat, auf Ja warten, dann umsetzen.
- Neue Arbeit auf einem eigenen Branch. Mergen und pushen nur auf ausdrückliche Ansage des Nutzers.
- Zurückgestellte Review-Befunde und offene Punkte stehen in `docs/superpowers/plans/2026-09-29-plan-*-followups.md`.

## Release-Ablauf (bei jedem neuen Build)

1. Version in `tasmota_manager/config.yaml` anheben (Semver; Fehlerbehebungen → Patch, neue Funktionen → Minor).
2. `tasmota_manager/CHANGELOG.md` ergänzen: neuer Abschnitt `## <Version>` oben, auf Englisch, aus Nutzersicht. HA zeigt diese Datei im Update-Dialog an. Nicht veröffentlichte Zwischenversionen in die nächste veröffentlichte Version zusammenfassen.
3. Annotierten Git-Tag `v<Version>` auf den Release-Commit setzen; Nachricht = Changelog-Abschnitt.
4. Nach Ansage des Nutzers **zuerst nur den Tag** pushen (`git push origin v<Version>`) und die GitHub-Spiegelung auslösen (siehe unten). Der Tag startet auf GitHub den Workflow `.github/workflows/publish.yml`, der die Images `ghcr.io/blogshot/{amd64,aarch64}-tasmota-manager:<Version>` baut. `config.yaml` verweist per `image:` darauf; HA baut die App nicht mehr selbst.
5. Warten, bis beide Images öffentlich abrufbar sind, z. B. anonym prüfen:
   `curl -s "https://ghcr.io/token?scope=repository:blogshot/aarch64-tasmota-manager:pull"` → Token → `curl -s -H "Authorization: Bearer <token>" -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json" https://ghcr.io/v2/blogshot/aarch64-tasmota-manager/manifests/<Version>` muss 200 liefern (für amd64 ebenso). Erst **danach** `main` pushen und erneut spiegeln. So bietet HA nie ein Update an, dessen Image noch fehlt. Forgejo-Pipeline-Ergebnis abwarten und melden.
6. Release auf GitHub zum Tag anlegen, Titel `Tasmota Manager <Version>`, Text = Changelog-Abschnitt plus Link auf die vollständige `CHANGELOG.md` auf GitHub. GitHub ist die öffentliche Quelle; ein Forgejo-Release sieht niemand außer dem Nutzer. Der GitHub-MCP kann keine Releases anlegen, deshalb über die REST-API mit dem Token aus `$GITHUB_PERSONAL_ACCESS_TOKEN` (fine-grained, Contents: Read and write), ohne ihn auszugeben:

   ```bash
   curl -s -X POST -H "Authorization: Bearer $GITHUB_PERSONAL_ACCESS_TOKEN" -H "Accept: application/vnd.github+json" \
     --data @release.json https://api.github.com/repos/Blogshot/tasmota-manager/releases
   # release.json: {"tag_name":"v<Version>","name":"Tasmota Manager <Version>","body":"…","make_latest":"true"}
   ```

   Der Tag muss vorher auf GitHub angekommen sein (Schritt 5). Antwortet GitHub mit 401, läuft Claude Code vermutlich noch mit einem alten Token: Die Sitzung hängt an einem `claude daemon`, der Terminal-Neustarts überlebt. Dann den Nutzer bitten, Claude Code zu beenden, `claude daemon stop --any` auszuführen und neu zu starten.

## Infrastruktur

- **GitHub `https://github.com/Blogshot/tasmota-manager` ist die zentrale, öffentliche Quelle der App.** Home Assistant installiert und aktualisiert von dort; README, Installations-Button, CHANGELOG-Links und Forenbeiträge verweisen immer auf GitHub.
- **Forgejo ist privat und die lokale Quelle.** Remote `origin` = `ssh://git@git.knott.ac:222/Sascha/tasmota-manager.git`; gepusht wird nur dorthin, Forgejo spiegelt nach GitHub. Nicht angemeldete Nutzer sehen auf Forgejo nichts, deshalb nie Forgejo-Links in öffentliche Texte schreiben. Alle Forgejo-API-Aufrufe brauchen das Token (siehe unten).
- **Nach jedem Push nach Forgejo die Spiegelung nach GitHub sofort auslösen**, statt auf das Intervall (1 h) zu warten. Der Push-Spiegel hat `sync_on_commit: false`, und die API kann bestehende Spiegel nicht ändern. Auslösen mit dem Token aus der Forgejo-MCP-Konfiguration (`~/.claude.json` → `mcpServers.forgejo.env.FORGEJO_TOKEN`), ohne ihn auszugeben:

  ```bash
  TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['forgejo']['env']['FORGEJO_TOKEN'])")
  curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: token $TOKEN" \
    https://git.knott.ac/api/v1/repos/Sascha/tasmota-manager/push_mirrors-sync
  ```

  Danach prüfen: `curl -s https://api.github.com/repos/Blogshot/tasmota-manager/commits/main` muss den neuen Commit zeigen. Forgejo-Releases werden nicht gespiegelt, nur Commits und Tags.
- CI: `.forgejo/workflows/ci.yml` auf dem Runner mit Label `swarm-manager` (Test-Job in `node:22`, Image-Build direkt auf dem Runner). Ergebnis per `https://git.knott.ac/api/v1/repos/Sascha/tasmota-manager/actions/tasks` abfragbar, mit Header `Authorization: token $TOKEN` (Repo ist privat).
- Commit-Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
