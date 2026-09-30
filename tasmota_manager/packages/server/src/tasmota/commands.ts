import { isObj } from './parse';

export type TopicPrefix = 'cmnd' | 'stat' | 'tele';

export function splitCommand(command: string): { name: string; args: string } {
  const trimmed = command.trim();
  const idx = trimmed.search(/\s/);
  if (idx === -1) return { name: trimmed, args: '' };
  return { name: trimmed.slice(0, idx), args: trimmed.slice(idx + 1).trim() };
}

/** Befehle ohne Argumente sind bei Tasmota Abfragen und damit gefahrlos wiederholbar. */
export function isQuery(command: string): boolean {
  return splitCommand(command).args === '';
}

export function isRejected(response: unknown): boolean {
  return isObj(response) && (response.Command === 'Unknown' || response.Command === 'Error');
}

export function buildTopic(fullTopic: string | null | undefined, prefix: TopicPrefix, topic: string): string {
  const template = fullTopic && fullTopic.includes('%prefix%') ? fullTopic : '%prefix%/%topic%/';
  const built = template.replaceAll('%prefix%', prefix).replaceAll('%topic%', topic);
  return built.endsWith('/') ? built : `${built}/`;
}

/** Prüft, ob eine stat-Nachricht die Antwort auf den gesendeten Befehl ist. */
export function matchesResponse(commandName: string, suffix: string, payload: unknown): boolean {
  const name = commandName.toUpperCase();
  if (name.startsWith('STATUS')) return suffix.startsWith('STATUS');
  if (suffix !== 'RESULT' || !isObj(payload)) return false;
  if ('Command' in payload) return true;
  const base = name.replace(/\d+$/, '');
  // Tasmota beantwortet einen Backlog mit einer RESULT-Nachricht pro Teilbefehl; die erste genügt als Bestätigung.
  if (base === 'BACKLOG') return true;
  if (base === 'TEMPLATE' && 'NAME' in payload) return true;
  return Object.keys(payload).some((key) => key.toUpperCase().startsWith(base));
}
