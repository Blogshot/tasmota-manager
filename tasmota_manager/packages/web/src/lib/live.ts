import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import type { Device, StatusResponse, WsMessage } from '@tm/shared';
import { useEffect } from 'react';

export function applyMessage(qc: QueryClient, msg: WsMessage): void {
  switch (msg.type) {
    case 'device:updated':
      qc.setQueryData<Device[]>(['devices'], (list) => {
        if (!list) return list;
        const index = list.findIndex((d) => d.id === msg.device.id);
        if (index === -1) return [...list, msg.device];
        const copy = list.slice();
        copy[index] = msg.device;
        return copy;
      });
      break;
    case 'device:removed':
      qc.setQueryData<Device[]>(['devices'], (list) => list?.filter((d) => d.id !== msg.id));
      break;
    case 'mqtt:status':
      qc.setQueryData<StatusResponse>(['status'], (s) => s && { ...s, mqtt: msg.status });
      break;
    case 'scan:progress': {
      const { type: _type, ...progress } = msg;
      qc.setQueryData(['scan'], progress);
      qc.setQueryData<StatusResponse>(['status'], (s) => s && { ...s, scanning: true });
      break;
    }
    case 'scan:done':
      qc.setQueryData(['scan'], null);
      qc.setQueryData<StatusResponse>(['status'], (s) => s && { ...s, scanning: false });
      break;
  }
}

export function useLiveUpdates(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let closed = false;
    const connect = () => {
      const url = new URL('api/ws', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.hash = '';
      socket = new WebSocket(url);
      socket.onopen = () => void qc.invalidateQueries();
      socket.onmessage = (event) => applyMessage(qc, JSON.parse(String(event.data)) as WsMessage);
      socket.onclose = () => {
        if (!closed) retry = window.setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [qc]);
}
