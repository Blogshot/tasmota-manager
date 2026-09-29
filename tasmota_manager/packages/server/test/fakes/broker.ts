import { type AddressInfo, createServer } from 'node:net';
import { Aedes } from 'aedes';

export async function startBroker(): Promise<{ url: string; close: () => Promise<void> }> {
  const broker = await Aedes.createBroker();
  const server = createServer(broker.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `mqtt://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        broker.close(() => server.close(() => resolve()));
      }),
  };
}
