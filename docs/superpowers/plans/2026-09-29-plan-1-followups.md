# Plan 1 – offene Nacharbeiten

Aus den Task-Reviews und dem Abschluss-Review von Plan 1 zurückgestellte Punkte. Sie sind für Plan 2/3 oder einen Aufräum-Durchgang gedacht.

## Zurückgestellte kleinere Befunde
- Task 1: minor (deferred): MAX_SCAN_PREFIX name misleading (plan-mandated)
- Task 1: minor (deferred): parseCidr accepts leading-zero octets (inconsistent with z.ipv4)
- Task 1: minor (deferred): empty-string vs null password both mean "clear"
- Task 1: minor (deferred): no tests for SettingsSchema sub-limits / CommandRequestSchema trim
- Task 2: minor (deferred): empty command name matches everything in matchesResponse (callers reject empty via CommandRequestSchema)
- Task 2: minor (deferred): name precedence differs (Status0 DeviceName first vs discovery fn[0] first)
- Task 2: minor (deferred): parser coverage gaps (parseVersion fallback, isRejected non-object, FriendlyName fallback)
- Task 3: minor (deferred): SettingsStore.load casts without validation
- Task 3: minor (deferred): restrict DB file permissions at server startup (plaintext device passwords)
- Task 4: minor (deferred): markUnreachable/updateRuntime emit even if unchanged; unchecked cast in upsert; orphan tags / case-sensitive tags; findByTopic ambiguity; throwing listener after commit
- Task 5: minor (deferred): expectCode double-await in http.test; fake Power arg parsing loose
- Task 6: minor (deferred): resubscribe race after reconnect (ready not reset)
- Task 6: minor (deferred): pending commands not rejected on connection close (wait full timeout)
- Task 6: minor (deferred): late publish-error callback may clear next pending entry (no identity check)
- Task 6: minor (deferred): stale late reply may resolve next same-name command
- Task 6: minor (deferred): watch() error handler may delete newer entry; start() twice leaks client; error handler swallows silently
- Task 6: minor (deferred): tests missing for reconnect/backoff/stop-rejects-pending/state event
- Task 7: minor (deferred): dead `passwords` field on StubMqttSender; missing tests (offline→http fallback, both fail, mqtt null, timeout passthrough); sendVia falls through to http host '' (unreachable)
- Task 8: minor (deferred): poller timer callback lacks try/catch (polling could stop on throw); start() twice orphans timer; no tests for scheduling/failure-counter reset
- Task 8: minor (deferred): probeHost swallows non-auth errors without debug log; throwing progress listener aborts scan
- Task 9: minor (deferred): event handlers lack try/catch around registry calls; start() not idempotent; broker-loss test synthetic; second.stop() not in finally
- Task 10: minor (deferred): readOptions swallows malformed options.json silently; TM_PORT not validated; interface regex prefix-matches "lo*"; coverage gaps (ssl, custom port, auth header redaction); redaction only one level deep
- Task 11: minor (deferred): guard tests missing ws upgrade / ::ffff: / static; no generic sanitized 500 handler; thin password-leak asserts on list/detail; hub socket 'error' listener; SPA fallback for non-GET
- Task 12: minor (deferred): partial-start leak if listen fails; stop() lacks error isolation and exits 0 on failure; main.ts no logged startup failure
- Task 13: minor (deferred): Toaster uses next-themes without provider (theme may mismatch HA dark mode); unguarded JSON.parse in ws onmessage; invalidateQueries() also resets ['scan']; theme applied once only; hook coverage thin
- Task 14: minor (deferred): devices query error shows "no devices" instead of error; no "no matches" message; selectedCount includes hidden rows; missing tests for tag filter/ScanButton/AddDeviceDialog; TDD RED step skipped by implementer
- Task 15: minor (deferred): blank sheet on failed load (no SheetTitle); unused detail query status; console input no aria-label; test gaps
- Task 16: minor (deferred): settings form keeps typed password / stale error after save when settings unchanged; missing tests (poll invalid, removePassword, mutation error); banner test timing-based
- Task 17: minor (deferred): Dockerfile runtime better-sqlite3 ^13.0.3 not pinned/lock-independent; no HEALTHCHECK/watchdog; CI docker job doesn't run image; esbuild size warning

## Getroffene Entscheidungen
- Task 2: Ruling: matchesResponse "Command" key matches any command — acceptable because Task 6 serializes commands per device (withLock) — if wrong, a rejection could be misattributed under concurrency
- Task 2: Ruling: loose prefix match (Power matches POWERONSTATE) kept as plan-mandated heuristic — cost if wrong: a stray RESULT could be taken as response; revisit if seen in practice
- Ruling: commit trailers name the subagent model that wrote the commit (e.g. Haiku 4.5) instead of Opus 5.5 — accurate attribution, no history rewrite — cost if wrong: cosmetic, fixable by rebase before merge
- Task 4: Ruling: accept plan-mandated finding "upsert not atomic" — wrap DB writes of upsert in a transaction, emit events after — spec requires reliable MAC merging; cost if wrong: none (behavior identical on success)
- Task 4: Ruling: accept coverage finding — add tests for updateRuntime, setAuthRequired, getStatus/statusJson, unknown-id null returns — cost: small
- Task 11: Ruling: accept deviation `as unknown as FastifyInstance` cast (pino Logger vs FastifyBaseLogger typing) — runtime identical — cost if wrong: lost typing on app, fixable later
- Task 15: Ruling: accept plan-mandated finding "command/remove mutations lack onError" — silent failures contradict spec error handling; add toast onError — cost: trivial
- Task 15: Ruling: also fix minor Console key={device.id} in same round (one-line, prevents history leaking across placeholder switch)
- Ruling: fix Important #1-#4 plus Minor #1 (banner states) and #2 (name precedence FriendlyName first) in one fix wave — user-visible/security; spec §5.1 probe-then-401 supports #2 over plan text — cost if wrong: small rework
- Ruling: Minor #3-#8 of final review stay deferred (topic collision, HTTP-found watch, %hostname%/%id%, queueQoSZero/watch timeout, poll resurrecting deleted device (partially covered by #1 guard), stale detail sheet)
- Ruling: residual — valid-but-malicious MQTT IP can repoint a known device to another LAN host (broker publisher trust); parked — requires broker write access; cost if wrong: credentials of that device sent to another LAN host; mitigation idea for later: only accept IP changes within scan CIDRs or require Status 0 confirmation over HTTP
- Ruling: residual — a non-Tasmota server mimicking Tasmota 401 JSON receives the global password once; parked — inherent to Tasmota's HTTP auth design
