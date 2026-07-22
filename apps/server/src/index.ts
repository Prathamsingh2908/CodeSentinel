import express from 'express';
import dotenv from 'dotenv';
import { App } from 'octokit';
import parseDiff from 'parse-diff';
import { createAIChunks } from './services/ai.service.js';
import { reviewQueue } from './queues/reviewQueue.js';
import './workers/reviewWorker.js'
import { redisConnection } from './config/redis.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// --- CONFIGURATION ---
const MAX_DIFF_SIZE_BYTES = 100 * 1024; // 100 KB limit to protect costs

const privateKey = process.env.GITHUB_PRIVATE_KEY;

if (!privateKey) {
  throw new Error("GITHUB_PRIVATE_KEY is missing from environment variables");
}

const ghApp = new App({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: privateKey,
});

app.use(express.json());
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'CodeSentinel is running 🚀'
  });
});
app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;

  if (event === 'pull_request' && (payload.action === 'opened' || payload.action === 'synchronize')) {
    const { installation, pull_request, repository } = payload;

    try {
      const octokit = await ghApp.getInstallationOctokit(installation.id);
      const { data: placeholderComment } = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: pull_request.number,
        body: '⏳ **CodeWatch AI is reviewing this PR.** Hang tight while I analyze the changes and prepare feedback.'
      });

      const placeholderCommentId = placeholderComment.id;
      console.log(`🔍 Fetching diff for PR #${pull_request.number}...`);

      const { data: diff } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner: repository.owner.login,
          repo: repository.name,
          pull_number: pull_request.number,
          mediaType: { format: "diff" },
        }
      ) as unknown as { data: string };

      // --- PROTECTION LAYER 1: SIZE CHECK ---
      if (typeof diff === 'string' && diff.length > MAX_DIFF_SIZE_BYTES) {
        console.warn(`⚠️ Skipping PR #${pull_request.number}: Diff size (${(diff.length / 1024).toFixed(2)} KB) exceeds limit.`);
        
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
          owner: repository.owner.login,
          repo: repository.name,
          comment_id: placeholderCommentId,
          body: `⚠️ **AI Review Skipped**: This Pull Request contains a very large diff (${(diff.length / 1024).toFixed(2)} KB). To maintain quality and performance, please break these changes into smaller, focused PRs.`
        });

        return res.status(200).send('Diff too large');
      }

      // --- PROTECTION LAYER 2: RATE LIMIT PER REPO ---
      const RATE_LIMIT_WINDOW = 3600; 
      const MAX_REVIEWS_PER_HOUR = 10;
      const rateLimitKey = `rate-limit:repo:${repository.id}`;

      
      const currentUsage = await redisConnection.incr(rateLimitKey);

      if (currentUsage === 1) {
        await redisConnection.expire(rateLimitKey, RATE_LIMIT_WINDOW);
      }

      // Check if limit exceeded
      if (currentUsage > MAX_REVIEWS_PER_HOUR) {
        const ttl = await redisConnection.ttl(rateLimitKey);
        const minutesLeft = Math.ceil(ttl / 60);

        console.warn(`🚫 Rate limit hit for Repo ID: ${repository.id} (${currentUsage} calls)`);

        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
          owner: repository.owner.login,
          repo: repository.name,
          comment_id: placeholderCommentId,
          body: `🚫 **Rate Limit Exceeded**: This repository has reached its limit of ${MAX_REVIEWS_PER_HOUR} AI reviews per hour. Please try again in ${minutesLeft} minutes.`
        });

        return res.status(429).send('Rate limit exceeded');
      }

      // --- END OF LAYER 2 ---

      const files = parseDiff(diff);
      const aiBuckets = createAIChunks(files);
      
      console.log(`🧠 Created ${aiBuckets.length} buckets. Sending to Queue...`);

      for (const bucket of aiBuckets) {
        const fileMatch = bucket.match(/--- File: (.*?) ---/);
        const fileName = fileMatch ? fileMatch[1] : (files[0]?.to || 'index.js');

        await reviewQueue.add('analyze-code', {
          bucket,
          installationId: installation.id,
          pullNumber: pull_request.number,
          owner: repository.owner.login,
          repo: repository.name,
          filePath: fileName,
          placeholderCommentId
        });
      }

      console.log(`🚀 Added ${aiBuckets.length} jobs to the queue.`);
    } catch (error) {
      console.error("❌ Error processing PR:", error);
    }
  }
  res.status(200).send('OK');
});

app.listen(PORT, () => console.log(`✅ Server ready on port ${PORT}`));

dotenv.config();

console.log("REDIS_HOST:", process.env.REDIS_HOST);
console.log("REDIS_PORT:", process.env.REDIS_PORT);
console.log("REDIS_TLS:", process.env.REDIS_TLS);