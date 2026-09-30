import { describe, expect, it } from 'vitest';
import { buildTopic, isQuery, isRejected, matchesResponse, splitCommand } from './commands';

describe('splitCommand', () => {
  it('trennt Befehl und Argumente', () => {
    expect(splitCommand('Power1 ON')).toEqual({ name: 'Power1', args: 'ON' });
    expect(splitCommand('  FriendlyName1   Küche & Bad ')).toEqual({ name: 'FriendlyName1', args: 'Küche & Bad' });
    expect(splitCommand('Status')).toEqual({ name: 'Status', args: '' });
  });
  it('erkennt Abfragen ohne Argumente', () => {
    expect(isQuery('Power')).toBe(true);
    expect(isQuery('Power TOGGLE')).toBe(false);
  });
});

describe('isRejected', () => {
  it('erkennt Unknown und Error', () => {
    expect(isRejected({ Command: 'Unknown' })).toBe(true);
    expect(isRejected({ Command: 'Error' })).toBe(true);
    expect(isRejected({ POWER: 'ON' })).toBe(false);
  });
});

describe('buildTopic', () => {
  it('nutzt das Standard-FullTopic', () => {
    expect(buildTopic(null, 'cmnd', 'keller')).toBe('cmnd/keller/');
    expect(buildTopic('%prefix%/%topic%/', 'stat', 'keller')).toBe('stat/keller/');
  });
  it('unterstützt umgestellte FullTopics und ergänzt den Schrägstrich', () => {
    expect(buildTopic('%topic%/%prefix%', 'tele', 'keller')).toBe('keller/tele/');
    expect(buildTopic('haus/%prefix%/%topic%/', 'cmnd', 'keller')).toBe('haus/cmnd/keller/');
  });
});

describe('matchesResponse', () => {
  it('akzeptiert für Backlog die erste RESULT-Nachricht', () => {
    expect(matchesResponse('Backlog', 'RESULT', { MqttHost: 'x' })).toBe(true);
    expect(matchesResponse('Backlog', 'STATUS0', {})).toBe(false);
  });

  it('ordnet Status-Befehle STATUS-Topics zu', () => {
    expect(matchesResponse('Status', 'STATUS0', {})).toBe(true);
    expect(matchesResponse('Status', 'RESULT', {})).toBe(false);
  });
  it('ordnet RESULT anhand des Schlüssels zu', () => {
    expect(matchesResponse('Power', 'RESULT', { POWER: 'ON' })).toBe(true);
    expect(matchesResponse('Power1', 'RESULT', { POWER1: 'ON' })).toBe(true);
    expect(matchesResponse('FriendlyName1', 'RESULT', { FriendlyName1: 'x' })).toBe(true);
    expect(matchesResponse('Timezone', 'RESULT', { POWER: 'ON' })).toBe(false);
  });
  it('akzeptiert Fehlerantworten und Template-Antworten', () => {
    expect(matchesResponse('Foo', 'RESULT', { Command: 'Unknown' })).toBe(true);
    expect(matchesResponse('Template', 'RESULT', { NAME: 'Generic', GPIO: [] })).toBe(true);
  });
  it('ignoriert Nicht-RESULT-Topics bei normalen Befehlen', () => {
    expect(matchesResponse('Power', 'POWER', 'ON')).toBe(false);
  });
});
