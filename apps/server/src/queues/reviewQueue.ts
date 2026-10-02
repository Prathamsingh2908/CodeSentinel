import { Queue } from 'bullmq';
import redisOptions from '../config/redis.js';

export const reviewQueue = new Queue('review-queue', {
  connection: redisOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: { count: 100 },
  },
});
