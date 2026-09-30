import { afterEach, describe, expect, it } from 'vitest';
import { HttpTransport } from '../../src/transport/http';
import { waitFor } from '../helpers';
import { FakeTasmota } from './fakeTasmota';

const http = new HttpTransport(1000);
let fake: FakeTasmota;

afterEach(async () => {
  await fake.stop();
});

const send = (command: string) => http.send({ host: fake.host, password: null }, command);

describe('FakeTasmota', () => {
  it('liefert Sensoren (Status 10) und Laufzeit (Status 11)', async () => {
    fake = await new FakeTasmota({ mac: 'AABBCC000001', sensors: { AM2301: { Temperature: 21.3 } } }).start();
    expect(await send('Status 10')).toMatchObject({ StatusSNS: { AM2301: { Temperature: 21.3 } } });
    expect(await send('Status 11')).toMatchObject({ StatusSTS: { UptimeSec: 100 } });
  });

  it('verwaltet Rules und Timer', async () => {
    fake = await new FakeTasmota({ mac: 'AABBCC000001' }).start();
    await send('Rule1 ON Power1#State DO Publish x ENDON');
    await send('Rule1 1');
    expect(await send('Rule1')).toMatchObject({ Rule1: { State: 'ON', Rules: 'ON Power1#State DO Publish x ENDON' } });
    await send('Timer3 {"Enable":1,"Time":"06:30"}');
    expect(await send('Timer3')).toMatchObject({ Timer3: { Enable: 1, Time: '06:30' } });
    expect(await send('Timers 0')).toEqual({ Timers: 'OFF' });
  });

  it('meldet die Zeitzone wie die Firmware als ±HH:MM bzw. 99', async () => {
    fake = await new FakeTasmota({ mac: 'AABBCC000001' }).start();
    expect(await send('Timezone')).toEqual({ Timezone: 99 });
    expect(await send('Timezone 1')).toEqual({ Timezone: '+01:00' });
    expect(await send('Timezone -5')).toEqual({ Timezone: '-05:00' });
    expect(await send('Timezone +05:30')).toEqual({ Timezone: '+05:30' });
    expect(await send('Timezone 99')).toEqual({ Timezone: 99 });
  });

  it('meldet Timer-Zeiten wie die Firmware: positiver Versatz ohne Vorzeichen, bei Uhrzeit nie eines', async () => {
    fake = await new FakeTasmota({ mac: 'AABBCC000001' }).start();
    expect(await send('Timer1 {"Mode":1,"Time":"+00:30"}')).toMatchObject({ Timer1: { Mode: 1, Time: '00:30' } });
    expect(await send('Timer1 {"Mode":2,"Time":"-00:30"}')).toMatchObject({ Timer1: { Mode: 2, Time: '-00:30' } });
    expect(await send('Timer1 {"Mode":0,"Time":"+06:30"}')).toMatchObject({ Timer1: { Mode: 0, Time: '06:30' } });
    // Ein „-" bedeutet in der Firmware +12 h; bei Modus 0 wird daraus eine andere Uhrzeit.
    expect(await send('Timer1 {"Mode":0,"Time":"-06:30"}')).toMatchObject({ Timer1: { Mode: 0, Time: '18:30' } });
    expect(await send('Timer1 {"Mode":1,"Time":"13:00"}')).toMatchObject({ Timer1: { Mode: 1, Time: '-01:00' } });
  });

  it('startet nach einem Backlog mit MQTT-Einstellungen genau einmal neu', async () => {
    fake = await new FakeTasmota({ mac: 'AABBCC000001', restartDelayMs: 20, downtimeMs: 100 }).start();
    await send('Backlog MqttHost neu.local; MqttUser u1');
    expect(fake.values.MqttHost).toBe('neu.local');
    await waitFor(() => fake.down);
    await expect(send('Status 11')).rejects.toMatchObject({ code: 'unreachable' });
    await waitFor(() => fake.restarts === 1);
    expect(await send('Status 11')).toMatchObject({ StatusSTS: { UptimeSec: 0 } });
  });

  it('bestätigt ignorierte Einstellungen, ohne sie zu übernehmen', async () => {
    fake = await new FakeTasmota({ mac: 'AABBCC000001', ignore: ['LedState'] }).start();
    expect(await send('LedState 5')).toEqual({ LedState: '1' });
  });
});
