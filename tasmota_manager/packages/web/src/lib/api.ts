import type {
  CommandResult,
  Device,
  DeviceDetail,
  DeviceUpdateRequest,
  JobView,
  PendingDevice,
  RuleState,
  Settings,
  SettingsUpdateRequest,
  StageRequest,
  StageResult,
  StatusResponse,
  TimersState,
} from '@tm/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Relative Pfade (ohne führenden Schrägstrich) funktionieren hinter dem Ingress-Präfix.
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`api/${path}`, init);
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, body.code ?? 'error', body.message ?? res.statusText);
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});

const deviceUrl = (id: string) => `devices/${encodeURIComponent(id)}`;

export const api = {
  devices: () => request<Device[]>('devices'),
  device: (id: string) => request<DeviceDetail>(deviceUrl(id)),
  addDevice: (ip: string) => request<Device>('devices', json('POST', { ip })),
  updateDevice: (id: string, patch: DeviceUpdateRequest) => request<Device>(deviceUrl(id), json('PATCH', patch)),
  removeDevice: (id: string) => request<void>(deviceUrl(id), { method: 'DELETE' }),
  command: (id: string, command: string) => request<CommandResult>(`${deviceUrl(id)}/command`, json('POST', { command })),
  settings: () => request<Settings>('settings'),
  updateSettings: (patch: SettingsUpdateRequest) => request<Settings>('settings', json('PUT', patch)),
  status: () => request<StatusResponse>('status'),
  scan: () => request<{ started: boolean }>('scan', json('POST', {})),
  changes: () => request<PendingDevice[]>('changes'),
  stage: (req: StageRequest) => request<StageResult>('changes', json('POST', req)),
  stageSuggestions: (deviceIds: string[]) => request<StageResult>('changes/suggestions', json('POST', { deviceIds })),
  discardChange: (id: number) => request<void>(`changes/${id}`, { method: 'DELETE' }),
  discardDevice: (deviceId: string) => request<void>(`changes?deviceId=${encodeURIComponent(deviceId)}`, { method: 'DELETE' }),
  discardAll: () => request<void>('changes', { method: 'DELETE' }),
  apply: (deviceIds?: string[]) => request<JobView>('changes/apply', json('POST', deviceIds ? { deviceIds } : {})),
  currentJob: () => request<{ job: JobView | null }>('jobs/current'),
  rules: (id: string) => request<RuleState[]>(`${deviceUrl(id)}/rules`),
  timers: (id: string) => request<TimersState>(`${deviceUrl(id)}/timers`),
};
