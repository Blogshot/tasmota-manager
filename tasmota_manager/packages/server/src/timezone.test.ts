import { describe, expect, it } from 'vitest';
import { tasmotaTimezone } from './timezone';

describe('tasmotaTimezone', () => {
  it('rechnet Europe/Berlin um', () => {
    expect(tasmotaTimezone('Europe/Berlin', 2026)).toEqual({ timezone: '99', timeStd: '0,0,10,1,3,60', timeDst: '0,0,3,1,2,120' });
  });
  it('rechnet America/New_York um (zweiter Sonntag im März, erster im November)', () => {
    expect(tasmotaTimezone('America/New_York', 2026)).toEqual({ timezone: '99', timeStd: '0,1,11,1,2,-300', timeDst: '0,2,3,1,2,-240' });
  });
  it('erkennt die Südhalbkugel (Australia/Sydney)', () => {
    expect(tasmotaTimezone('Australia/Sydney', 2026)).toEqual({ timezone: '99', timeStd: '1,1,4,1,3,600', timeDst: '1,1,10,1,2,660' });
  });
  it('nutzt ohne Sommerzeit einen festen Versatz', () => {
    expect(tasmotaTimezone('Asia/Tokyo', 2026)).toEqual({ timezone: '+09:00', timeStd: null, timeDst: null });
    expect(tasmotaTimezone('Asia/Kolkata', 2026)).toEqual({ timezone: '+05:30', timeStd: null, timeDst: null });
  });
  it('liefert null für unbekannte Zonen', () => {
    expect(tasmotaTimezone('Mars/Olympus', 2026)).toBeNull();
  });
});
