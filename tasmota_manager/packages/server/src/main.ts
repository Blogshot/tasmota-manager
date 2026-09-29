import { loadConfig } from './config';
import { startServer } from './server';

const config = await loadConfig();
const server = await startServer(config, { version: process.env.TM_VERSION });

const shutdown = (): void => {
  void server.stop().finally(() => process.exit(0));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
