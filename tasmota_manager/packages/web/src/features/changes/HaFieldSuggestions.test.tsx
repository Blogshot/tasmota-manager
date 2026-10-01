import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { HaFieldSuggestions } from './HaFieldSuggestions';

vi.mock('@/lib/api', () => ({ api: { status: vi.fn() }, ApiError: class extends Error {} }));

const all = new Set(['Timezone', 'TimeStd', 'TimeDst', 'NtpServer1', 'MqttHost', 'MqttPort', 'MqttUser', 'SetOption8']);

describe('HaFieldSuggestions', () => {
  beforeEach(() => {
    vi.mocked(api.status).mockResolvedValue({
      mqtt: 'connected', version: 'x', scanning: false, haLocation: null,
      haSuggestions: {
        timezone: { zone: 'Europe/Berlin', timezone: '99', timeStd: '0,0,10,1,3,60', timeDst: '0,0,3,1,2,120' },
        ntpServer: 'de.pool.ntp.org', mqtt: { host: '192.168.1.5', port: 1883 }, mqttUser: 'tasmota', fahrenheit: false,
      },
    });
  });

  it('füllt Zeitzone samt Sommerzeitregeln', async () => {
    const onFill = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<HaFieldSuggestions fieldKey="Timezone" visibleKeys={all} onFill={onFill} />);
    await user.click(await screen.findByRole('button', { name: /Europe\/Berlin/ }));
    expect(onFill).toHaveBeenCalledWith({ Timezone: '99', TimeStd: '0,0,10,1,3,60', TimeDst: '0,0,3,1,2,120' });
  });

  it('füllt MQTT-Host und -Port gemeinsam', async () => {
    const onFill = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<HaFieldSuggestions fieldKey="MqttHost" visibleKeys={all} onFill={onFill} />);
    await user.click(await screen.findByRole('button', { name: /192\.168\.1\.5:1883/ }));
    expect(onFill).toHaveBeenCalledWith({ MqttHost: '192.168.1.5', MqttPort: '1883' });
  });

  it('zeigt nichts für Felder ohne Vorschlag', () => {
    renderWithProviders(<HaFieldSuggestions fieldKey="LedState" visibleKeys={all} onFill={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
