import { createApp } from './app';
import { config } from './config';
import { logger } from './middleware/logger';
import { prisma } from './db';
import { redis } from './redis';

async function main(): Promise<void> {
  const app = createApp();

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV },
      'Server started'
    );
  });

  // Graceful shutdown — finish in-flight requests before closing
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received');

    server.close(async () => {
      await prisma.$disconnect();
      redis.disconnect();
      logger.info('Server shut down cleanly');
      process.exit(0);
    });

    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
