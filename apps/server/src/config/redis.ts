import 'dotenv/config';
import { Redis } from 'ioredis';

export const redisConnection = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined, 
  maxRetriesPerRequest: null,
  enableReadyCheck: false,    // Stops extra 'INFO' commands on every connection
  lazyConnect: true,          // Don't connect until needed
  connectTimeout: 10000,
});