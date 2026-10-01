import { describe, expect, it } from 'vitest';
import { capabilitiesOf } from './capabilities';

const status = (sts: Record<string, unknown>) => ({ StatusSTS: sts });
const sensors = (sns: Record<string, unknown>) => ({ StatusSNS: sns });

describe('capabilitiesOf', () => {
  it('erkennt Steckdose mit Energiemessung', () => {
    expect(capabilitiesOf(status({ POWER: 'ON' }), sensors({ ENERGY: { Power: 5 } }), null)).toEqual(['energy', 'relay']);
  });
  it('erkennt Licht über Dimmer, Farbe oder Modulnamen', () => {
    expect(capabilitiesOf(status({ POWER: 'ON', Dimmer: 40 }), sensors({}), null)).toEqual(['light', 'relay']);
    expect(capabilitiesOf(status({ POWER: 'ON' }), sensors({}), 'Sonoff B1 Bulb')).toEqual(['light', 'relay']);
  });
  it('erkennt Mehrfach-Relais', () => {
    expect(capabilitiesOf(status({ POWER1: 'ON', POWER2: 'OFF' }), sensors({}), null)).toEqual(['relay', 'multiRelay']);
  });
  it('erkennt Klima, aber nicht die Chip-Temperatur', () => {
    expect(capabilitiesOf(status({}), sensors({ AM2301: { Temperature: 21, Humidity: 40 } }), null)).toEqual(['climate']);
    expect(capabilitiesOf(status({ POWER: 'ON' }), sensors({ ESP32: { Temperature: 40 } }), null)).toEqual(['relay']);
  });
  it('liefert ohne Status nichts', () => {
    expect(capabilitiesOf(undefined, undefined, null)).toEqual([]);
  });
});
