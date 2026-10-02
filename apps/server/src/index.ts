import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { App } from 'octokit';
import parseDiff from 'parse-diff';
import { createAIChunks } from './services/ai.service.js';
import { reviewQueue } from './queues/reviewQueue.js';
import './workers/reviewWorker.js'
import { rateLimitRedis } from './config/redis.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// --- CONFIGURATION ---
const MAX_DIFF_SIZE_BYTES = 100 * 1024; // 100 KB limit to protect costs

const privateKey = process.env.GITHUB_PRIVATE_KEY;
const appId = process.env.GITHUB_APP_ID;

if (!privateKey) {
  throw new Error("GITHUB_PRIVATE_KEY is missing from environment variables");
}
if (!appId) {
  throw new Error("GITHUB_APP_ID is missing from environment variables");
}

const ghApp = new App({
  appId,
  privateKey,
});

// --- WEBHOOK SIGNATURE VERIFICATION ---
function verifySignature(req: express.Request): boolean {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!signature || !secret) return false;

  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(req.body).digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(digest)
    );
  } catch {
    return false;
  }
}

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'CodeSentinel is running 🚀'
  });
});

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifySignature(req)) {
    return res.status(401).send('Invalid signature');
  }

  const payload = JSON.parse(req.body.toString());
  const event = req.headers['x-github-event'];

  // Respond immediately — GitHub only cares that we received it
  res.status(200).send('OK');

  // Everything below runs AFTER the response is sent
  if (event !== 'pull_request') return;
  if (payload.action !== 'opened' && payload.action !== 'synchronize') return;
  const { installation, pull_request, repository } = payload;

  try {
    const octokit = await ghApp.getInstallationOctokit(installation.id);
    const { data: placeholderComment } = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: pull_request.number,
      body: '⏳ **CodeSentinel AI is reviewing this PR.** Hang tight while I analyze the changes and prepare feedback.'
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

      return;
    }

    // --- PROTECTION LAYER 2: RATE LIMIT PER REPO ---
    const RATE_LIMIT_WINDOW = 86400; // 24 hours
    const MAX_REVIEWS_PER_DAY = 10;
    const rateLimitKey = `rate-limit:repo:${repository.id}`;

    const currentUsage = await rateLimitRedis.incr(rateLimitKey);

    if (currentUsage === 1) {
      await rateLimitRedis.expire(rateLimitKey, RATE_LIMIT_WINDOW);
    } else {
      // Safety net: if key somehow has no TTL, apply one
      const ttl = await rateLimitRedis.ttl(rateLimitKey);
      if (ttl === -1) {
        await rateLimitRedis.expire(rateLimitKey, RATE_LIMIT_WINDOW);
      }
    }

    // Check if limit exceeded
    if (currentUsage > MAX_REVIEWS_PER_DAY) {
      const ttl = await rateLimitRedis.ttl(rateLimitKey);
      const hoursLeft = Math.ceil(ttl / 3600);

      console.warn(`🚫 Rate limit hit for Repo ID: ${repository.id} (${currentUsage} calls)`);

      await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner: repository.owner.login,
        repo: repository.name,
        comment_id: placeholderCommentId,
        body: `🚫 **Rate Limit Exceeded**: This repository has reached its limit of ${MAX_REVIEWS_PER_DAY} AI reviews per day. Please try again in ${hoursLeft} hours.`
      });

      return;
    }

    // --- END OF LAYER 2 ---

    const files = parseDiff(diff);
    const aiBuckets = createAIChunks(files);

    console.log(`🧠 Created ${aiBuckets.length} buckets. Sending to Queue...`);

    for (const bucket of aiBuckets) {
      const fileMatch = bucket.match(/--- File: (.*?) ---/);
      if (!fileMatch) {
        console.error(`❌ Could not extract filename from bucket, skipping enqueue`);
        continue;
      }
      const fileName = fileMatch[1];

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
    console.error(`❌ Error processing PR #${pull_request?.number}:`, error);
  }
});

app.listen(PORT, () => console.log(`✅ Server ready on port ${PORT}`));
