import 'dotenv/config';
import { Redis } from 'ioredis';

const redisOptions = {
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  connectTimeout: 10000,
};

export default redisOptions;

// Separate instance for non-BullMQ use (rate limiting in index.ts)
export const rateLimitRedis = new Redis(redisOptions);
