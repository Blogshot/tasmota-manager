import type { ErrorCode } from '@tm/shared';

export class TransportError extends Error {
  /**
   * @param maybeExecuted Ob das Gerät den Befehl trotz des Fehlers ausgeführt haben könnte. Nur wer sicher weiß,
   *   dass nichts beim Gerät ankam (keine Verbindung, nichts gesendet), setzt `false`. Alles andere bleibt mehrdeutig,
   *   und nicht idempotente Befehle werden dann weder wiederholt noch über einen anderen Kanal gesendet.
   */
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly maybeExecuted = true,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}
