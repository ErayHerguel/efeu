import { describe, expect, it } from 'vitest';
import { describeCheckError } from './updater';

describe('Update-Meldungen', () => {
  it('zeigt fehlende Update-Infos als „aktuell“ und Verbindungsfehler neutral', () => {
    expect(describeCheckError(new Error('Could not fetch a valid release JSON from the remote'))).toBe('efeu ist auf dem neuesten Stand');
    expect(describeCheckError('error sending request: dns error: failed to lookup address')).toContain('Keine Verbindung');
    expect(describeCheckError('irgendwas')).toContain('nicht möglich');
  });
});
