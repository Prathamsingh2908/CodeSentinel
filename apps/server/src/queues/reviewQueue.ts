import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis.js';

export const reviewQueue = new Queue('review-queue', {
  connection: redisConnection,
  
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, 
    },
    removeOnComplete: true, 
    removeOnFail: {
      count: 100,
    },
  },
});