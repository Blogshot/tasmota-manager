import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

describe('createLogger', () => {
  it('schwärzt Passwörter', () => {
    const lines: string[] = [];
    const log = createLogger('info', { write: (line: string) => lines.push(line) });
    log.info({ password: 'geheim', settings: { globalPassword: 'auch-geheim' } }, 'test');
    expect(lines.join('')).not.toContain('geheim');
    expect(lines.join('')).toContain('***');
  });
});
