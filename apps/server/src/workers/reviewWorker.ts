import { Worker } from 'bullmq';
import redisOptions from '../config/redis.js';
import { analyzeCode, type AIReview } from '../ai.js';
import { App } from 'octokit';
import dotenv from 'dotenv';

dotenv.config();

const privateKey = process.env.GITHUB_PRIVATE_KEY;
const appId = process.env.GITHUB_APP_ID;

if (!privateKey) {
  throw new Error('GITHUB_PRIVATE_KEY is missing from environment variables');
}
if (!appId) {
  throw new Error('GITHUB_APP_ID is missing from environment variables');
}

const ghApp = new App({
  appId,
  privateKey,
});

interface JobData {
  bucket: string;
  installationId: number;
  pullNumber: number;
  owner: string;
  repo: string;
  filePath: string;
  placeholderCommentId: number;
}

function isValidReview(r: any): r is AIReview {
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.file === 'string' &&
    r.file.length > 0 &&
    typeof r.line === 'number' &&
    Number.isFinite(r.line) &&
    r.line > 0 &&
    (r.endLine === undefined ||
      (typeof r.endLine === 'number' &&
        Number.isFinite(r.endLine) &&
        r.endLine >= r.line)) &&
    ['CRITICAL', 'MEDIUM', 'LOW'].includes(r.severity) &&
    typeof r.comment === 'string' &&
    r.comment.length > 0
  );
}

function isNonRetryableError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    [401, 403, 404].includes((err as any).status)
  );
}

new Worker(
  'review-queue',
  async (job) => {
    const jobData = job.data as JobData;

    if (
      typeof jobData.bucket !== 'string' ||
      !Number.isFinite(jobData.installationId) ||
      !Number.isFinite(jobData.pullNumber) ||
      typeof jobData.owner !== 'string' ||
      typeof jobData.repo !== 'string'
    ) {
      console.error('❌ Invalid job data shape:', job.id, jobData);
      throw new Error('Invalid job data shape');
    }

    const {
      bucket,
      installationId,
      pullNumber,
      owner,
      repo,
      filePath,
      placeholderCommentId,
    } = jobData;

    const safeFilePath = filePath || 'unknown';
    const fileName = safeFilePath.split('/').pop() || safeFilePath;

    const commentId = Number(placeholderCommentId);
    const hasPlaceholderComment = Number.isFinite(commentId) && commentId > 0;

    console.log(`👷 Worker: Processing PR #${pullNumber} [Job ID: ${job.id}]`);

    let octokit: Awaited<ReturnType<typeof ghApp.getInstallationOctokit>>;
    try {
      octokit = await ghApp.getInstallationOctokit(installationId);
    } catch (error) {
      console.error(
        `❌ Failed to get installation octokit for installation ${installationId}:`,
        error
      );
      if (isNonRetryableError(error)) {
        console.error('Installation not found or revoked, not retrying');
        return;
      }
      throw error;
    }

    try {
      const aiReviews = await analyzeCode(bucket);
      console.log('📊 AI Reviews received:', JSON.stringify(aiReviews, null, 2));

      const validReviews = aiReviews.filter(isValidReview);

      if (validReviews.length < aiReviews.length) {
        console.warn(
          `⚠️ Filtered out ${aiReviews.length - validReviews.length} invalid reviews from AI response`
        );
      }

      if (validReviews.length > 0) {
        const prData = await octokit.request(
          'GET /repos/{owner}/{repo}/pulls/{pull_number}',
          { owner, repo, pull_number: pullNumber }
        );
        const commitSha = prData.data.head.sha;

        const changedFilePaths = new Set<string>();
        let page = 1;
        while (true) {
          const prFiles = await octokit.request(
            'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
            { owner, repo, pull_number: pullNumber, per_page: 100, page }
          );
          for (const f of prFiles.data) {
            changedFilePaths.add(f.filename);
          }
          if (prFiles.data.length < 100) break;
          page++;
        }

        let successCount = 0;
        let failCount = 0;
        const successCounts = { CRITICAL: 0, MEDIUM: 0, LOW: 0 };

        for (const review of validReviews) {
          if (!changedFilePaths.has(review.file)) {
            console.warn(
              `⚠️ Skipping comment for ${review.file}:${review.line} - file not in PR diff`
            );
            failCount++;
            continue;
          }

          try {
            const hasRange =
              review.endLine !== undefined && review.endLine > review.line;

            const severityMetadata = {
              CRITICAL: { icon: '🔴', label: 'CRITICAL' },
              MEDIUM: { icon: '🟡', label: 'MEDIUM' },
              LOW: { icon: '🔵', label: 'LOW' },
            }[review.severity];

            await octokit.request(
              'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments',
              {
                owner,
                repo,
                pull_number: pullNumber,
                body: `${severityMetadata.icon} **${severityMetadata.label}**: ${review.comment}`,
                commit_id: commitSha,
                path: review.file,
                side: 'RIGHT',
                line: hasRange ? review.endLine : review.line,
                ...(hasRange && {
                  start_line: review.line,
                  start_side: 'RIGHT',
                }),
              }
            );

            successCount++;
            successCounts[review.severity]++;
          } catch (commentError: any) {
            failCount++;
            console.error(
              `❌ Failed to post comment for ${review.file}:${review.line}:`,
              commentError?.message || commentError
            );
          }
        }

        console.log(
          `✅ Posted ${successCount}/${validReviews.length} comments to PR #${pullNumber} (${failCount} failed)`
        );

        const totalBySeverity = {
          CRITICAL: validReviews.filter((r) => r.severity === 'CRITICAL').length,
          MEDIUM: validReviews.filter((r) => r.severity === 'MEDIUM').length,
          LOW: validReviews.filter((r) => r.severity === 'LOW').length,
        };

        const summaryTable = `
### 🤖 AI Code Review Summary for \`${fileName}\`

| Severity | Issues Found | Posted |
| :--- | :--- | :--- |
| 🔴 **CRITICAL** | ${totalBySeverity.CRITICAL} | ${successCounts.CRITICAL} |
| 🟡 **MEDIUM** | ${totalBySeverity.MEDIUM} | ${successCounts.MEDIUM} |
| 🔵 **LOW** | ${totalBySeverity.LOW} | ${successCounts.LOW} |

---
*Detailed feedback has been added to the **Files changed** tab. Please address the critical items before merging.*
${failCount > 0 ? `\n⚠️ Note: ${failCount} comment(s) could not be posted due to line number or file path issues.` : ''}
        `;

        if (hasPlaceholderComment) {
          await octokit.request(
            'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
            {
              owner,
              repo,
              comment_id: commentId,
              body: summaryTable.trim(),
            }
          );
        } else {
          await octokit.request(
            'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
            {
              owner,
              repo,
              issue_number: pullNumber,
              body: summaryTable.trim(),
            }
          );
        }
      } else {
        const isLikelyFailure = aiReviews.length > 0 && validReviews.length === 0;

        if (hasPlaceholderComment) {
          await octokit.request(
            'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
            {
              owner,
              repo,
              comment_id: commentId,
              body: isLikelyFailure
                ? `⚠️ **CodeSentinel AI Review** for \`${fileName}\`\n\nThe AI analysis returned invalid data. This may indicate a parsing error. Please check the logs or retry.`
                : `✅ **CodeSentinel AI Review Complete** for \`${fileName}\`\n\nNo issues were found in this chunk.`,
            }
          );
        }

        if (isLikelyFailure) {
          console.warn(
            `⚠️ AI returned ${aiReviews.length} reviews but none were valid for PR #${pullNumber}`
          );
        } else {
          console.log(`✅ No issues found by AI for PR #${pullNumber}`);
        }
      }
    } catch (error) {
      console.error(`❌ Worker Error processing PR #${pullNumber}:`, error);

      if (hasPlaceholderComment && octokit) {
        try {
          await octokit.request(
            'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
            {
              owner,
              repo,
              comment_id: commentId,
              body: `❌ **CodeSentinel AI Review Failed** for \`${fileName}\`.\n\nAn error occurred during analysis. The issue has been logged.`,
            }
          );
        } catch (patchError) {
          console.error(
            '❌ Failed to patch placeholder comment after worker error:',
            patchError
          );
        }
      }

      if (isNonRetryableError(error)) {
        console.error('Non-retryable error, not throwing');
        return;
      }

      throw error;
    }
  },
  {
    connection: redisOptions,
    concurrency: 5,
    drainDelay: 60,
    lockDuration: 60000,
    lockRenewTime: 45000,
    stalledInterval: 300000,
  }
);
