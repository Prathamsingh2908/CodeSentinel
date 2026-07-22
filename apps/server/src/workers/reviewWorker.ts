import { Worker } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { analyzeCode } from '../ai.js';
import { App } from 'octokit';
import dotenv from 'dotenv';

dotenv.config();

const privateKey = process.env.GITHUB_PRIVATE_KEY;

if (!privateKey) {
  throw new Error("GITHUB_PRIVATE_KEY is missing from environment variables");
}
const ghApp = new App({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: privateKey,
});

export const reviewWorker = new Worker('review-queue', async (job) => {
  const { bucket, installationId, pullNumber, owner, repo, filePath, placeholderCommentId } = job.data;
  const commentId = Number(placeholderCommentId);
  const hasPlaceholderComment = Number.isFinite(commentId) && commentId > 0;

  console.log(`👷 Worker: Processing PR #${pullNumber} [Job ID: ${job.id}]`);

  try {
    const octokit = await ghApp.getInstallationOctokit(installationId);
    
    // 1. Get AI Analysis
    const aiReviews = await analyzeCode(bucket);

    console.log('📊 AI Reviews received:', JSON.stringify(aiReviews, null, 2));

    if (aiReviews && aiReviews.length > 0) {
      // 2. Post Line-by-Line Comments
      await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
        owner,
        repo,
        pull_number: pullNumber,
        event: 'COMMENT',
        comments: aiReviews.map((r: any) => {
          const hasRange = r.endLine && Number(r.endLine) > Number(r.line);
          
          const severityMetadata = {
            CRITICAL: { icon: '🔴', label: 'CRITICAL' },
            MEDIUM: { icon: '🟡', label: 'MEDIUM' },
            LOW: { icon: '🔵', label: 'LOW' }
          }[r.severity as 'CRITICAL' | 'MEDIUM' | 'LOW'] || { icon: '💡', label: 'SUGGESTION' };

          return {
            path: r.file || filePath,
            body: `${severityMetadata.icon} **${severityMetadata.label}**: ${r.comment}`,
            side: 'RIGHT',
            line: hasRange ? Number(r.endLine) : Number(r.line),
            ...(hasRange && {
              start_line: Number(r.line),
              start_side: 'RIGHT'
            })
          };
        }),
      });

      // 3. Generate and Post Summary Table
      const counts = {
        CRITICAL: aiReviews.filter((r: any) => r.severity === 'CRITICAL').length,
        MEDIUM: aiReviews.filter((r: any) => r.severity === 'MEDIUM').length,
        LOW: aiReviews.filter((r: any) => r.severity === 'LOW').length,
      };

      const summaryTable = `
### 🤖 AI Code Review Summary for \`${filePath.split('/').pop()}\`

| Severity | Issues Found |
| :--- | :--- |
| 🔴 **CRITICAL** | ${counts.CRITICAL} |
| 🟡 **MEDIUM** | ${counts.MEDIUM} |
| 🔵 **LOW** | ${counts.LOW} |

---
*Detailed feedback has been added to the **Files changed** tab. Please address the critical items before merging.*
      `;

      if (hasPlaceholderComment) {
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
          owner,
          repo,
          comment_id: commentId,
          body: summaryTable.trim(),
        });
      } else {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
          owner,
          repo,
          issue_number: pullNumber,
          body: summaryTable.trim(),
        });
      }

      console.log(`✅ Posted ${aiReviews.length} comments and summary table to PR #${pullNumber}`);
    } else {
      if (hasPlaceholderComment) {
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
          owner,
          repo,
          comment_id: commentId,
          body: `✅ **CodeWatch AI Review Complete** for \`${filePath.split('/').pop()}\`\n\nNo issues were found in this chunk.`
        });
      }
      console.log(`✅ No issues found by AI for PR #${pullNumber}`);
    }
  } catch (error) {
    if (hasPlaceholderComment) {
      try {
        const octokit = await ghApp.getInstallationOctokit(installationId);
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
          owner,
          repo,
          comment_id: commentId,
          body: `❌ **CodeWatch AI Review Failed** for \`${filePath.split('/').pop()}\`.\n\nPlease retry by pushing a new commit or re-opening this PR.`
        });
      } catch (patchError) {
        console.error('❌ Failed to patch placeholder comment after worker error:', patchError);
      }
    }
    console.error("❌ Worker Error:", error);
    throw error; 
  }
}, { connection: redisConnection,
  concurrency: 5,
  drainDelay: 60,
  lockDuration: 60000,      // Keep lock for 1 minute
  lockRenewTime: 45000,     // Renew every 15s instead of every 1s
  stalledInterval: 300000,
 });