# CodeSentinel

CodeSentinel is a GitHub App that automatically reviews pull requests using the GPT-OSS-120B model via the Groq API. When a pull request is opened, it fetches the diff, partitions it into token-aware chunks (never mixing files), sends each chunk to the model with a structured prompt, and posts the results as inline review comments on the exact changed lines — the same way a human reviewer would.

The smallest useful version: install it on a repo, open a PR, get line-level feedback without asking anyone.

<p align="center">
  <a href="https://www.youtube.com/watch?v=eUuC07FqDHA">
    <img src="https://img.shields.io/badge/Watch-Demo-blue?style=for-the-badge&logo=youtube" alt="Demo">
  </a>
  <a href="https://github.com/apps/code-sentinel1">
    <img src="https://img.shields.io/badge/Install-CodeSentinel-green?style=for-the-badge&logo=github" alt="Install CodeSentinel">
  </a>
</p>

---

## Why I Built This

As a solo developer I open PRs on my own repos constantly but have no one to review them. I'd either merge unreviewed code and catch bugs later, or spend time reviewing my own work which defeats the purpose. I wanted something that would give me an actual second opinion — not just linting errors but real feedback on logic, security, and architecture.

I also wanted to understand how webhook-driven async systems work under the hood, so building this was as much about learning the infrastructure as solving the problem. The interesting engineering turned out to be less about the LLM and more about how to reliably process GitHub events, chunk diffs without losing context, and post structured feedback back to the right line numbers.

---

## How It Works

```
GitHub PR
   │  (pull_request webhook)
   ▼
Render (Express server, Docker)
   │  verify signature → ack 200 → fetch diff → rate limit → chunk → enqueue
   ▼
BullMQ ──► Redis (Upstash)
   │
   ▼
Worker (same process)
   │  one job per chunk
   ▼
Groq (GPT-OSS-120B)
   │  structured JSON findings
   ▼
GitHub inline review comments
```

The server acknowledges the webhook immediately, then prepares the review (fetches the diff, applies the size and rate-limit checks, chunks it) and queues one BullMQ job per chunk. The worker, which runs in the same process, does the slow part: calling the model and posting comments. Jobs run with concurrency 5 and retry up to 3 times with exponential backoff.

The system has been tested end-to-end with a real GitHub pull request: opening the PR triggered the webhook, the job was queued and processed, and CodeSentinel successfully posted an inline review comment on the changed line.

---

## Review Flow

1. **Webhook received** — GitHub sends a `pull_request` event (`opened` or `synchronize`) to the server hosted on Render. Other events and actions are ignored.
2. **Signature verified** — the request is checked with HMAC-SHA256 against the raw body, then acknowledged with a 200 right away. A "reviewing" placeholder comment is posted on the PR.
3. **Diff fetched** — the server authenticates as the GitHub App installation and fetches the PR diff. Diffs over 100 KB are skipped with an explanatory comment, and repos over the daily limit get a rate-limit notice.
4. **Diff parsed** — `parse-diff` turns the raw diff into files, hunks, and line numbers.
5. **Token-aware chunks created** — each file's hunks are packed into chunks within the token budget, never mixing two files in one prompt. Each chunk becomes a BullMQ job.
6. **Groq review** — the worker sends each chunk to GPT-OSS-120B with a structured prompt that returns JSON findings.
7. **Findings mapped to changed lines** — responses are validated and matched to real changed files and line numbers.
8. **Inline GitHub comments posted** — each finding is posted as an inline review comment on the exact line, and the placeholder comment is updated with a severity summary.

---

## Tech Stack

- **Node.js / TypeScript** — server and worker
- **GitHub Apps / Octokit** — authentication, fetching PR data, posting inline comments
- **GPT-OSS-120B via Groq** — code review model
- **BullMQ** — job queue with retries and persistence
- **Upstash Redis** — BullMQ backing store and rate limiting
- **parse-diff** — diff parsing
- **Docker** — containerized build
- **Render** — production hosting

---

## How to Run It

Prereqs: Node.js 20+, npm, Redis (Upstash or local), GitHub App credentials.

**1. Install dependencies**

```bash
cd apps/server
npm install
```

**2. Create `apps/server/.env`**

```env
PORT=3001
GITHUB_APP_ID=your_app_id
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----..."
GITHUB_WEBHOOK_SECRET=your_webhook_secret
GROQ_API_KEY=your_groq_api_key
REDIS_HOST=your_redis_host
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
REDIS_TLS=true
```

`GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY` are validated at startup, so a missing value fails fast with a clear error instead of a cryptic crash later.

**3. Run in development**

```bash
npm run dev
```

To test webhooks locally use a tunnel (ngrok or Smee) and point your GitHub App webhook URL to the tunnel endpoint.

**4. Install the app on a repo**

Go to https://github.com/apps/code-sentinel1, click Install, select a repo. Open any PR — CodeSentinel will post review comments automatically.

### Production Deployment

CodeSentinel is containerized with Docker and deployed on Render. Redis is hosted on Upstash and serves both BullMQ and rate limiting. The server and the BullMQ worker run in the same container. Production environment variables (GitHub App credentials, webhook secret, Groq API key, Redis connection details) are configured in Render's dashboard and are never committed to the repository.

---

## Architecture Decisions

**Async processing over synchronous**

The first decision was whether to process the review synchronously inside the webhook handler or offload it to a queue. GitHub expects a response within 10 seconds or it marks the webhook as failed and retries. LLM inference can take 10-30 seconds depending on diff size. The only real option was to acknowledge immediately and process in the background. The webhook handler acknowledges the event right away and queues the review in BullMQ, and a worker processes the review asynchronously. This avoids webhook timeout issues no matter how large the diff is. BullMQ handles retries, job persistence, and backpressure out of the box.

The handler verifies the signature and responds 200 before doing anything slow. The GitHub calls that follow (placeholder comment, diff fetch) run after the response is sent, and the model calls run in the worker. An earlier version awaited several GitHub API calls before responding, which could blow the 10s window and cause GitHub to retry, producing duplicate reviews.

**Webhook signature verification on the raw body**

Anyone who knows the webhook URL could otherwise POST fake payloads and burn Groq credits. Every request is verified with HMAC-SHA256 against the raw request bytes before anything else runs. This meant scoping the body parser: a global `express.json()` destroys the raw bytes the HMAC needs, so the webhook route reads the raw body and parses JSON itself only after verification.

**File-scoped, token-aware chunking, not naive line splitting**

A large PR can have 3000+ changed lines across 30 files. Sending it all in one LLM call hits token limits. The naive solution — split every N lines — breaks context badly: a function definition ends up in chunk 1, its body in chunk 3, and the model loses the thread.

I used file-level partitioning as a hard rule instead: two files never share a prompt, so the model never sees one file's code while reviewing another. Within a file, hunks are packed greedily into chunks up to the token budget, and a new chunk starts only when the next hunk won't fit. Git hunks naturally include surrounding context lines, so the model gets function signatures even without explicit boundary detection.

Details that matter:
- Token counts are tracked incrementally per hunk, not by re-encoding the whole growing chunk each time.
- A single hunk larger than the token limit is split line by line instead of silently blowing past the limit.
- Every line is prefixed with its absolute new-file line number (`L42:`) and removed lines with `OLD:`, so the model can cite exact lines.
- Tokens are estimated with a GPT-2 tokenizer as a proxy for Groq's, which is off by roughly 10–20%, so the limit is set conservatively at 1500 tokens as a safety margin.

**parse-diff over manual diff parsing**

Git diffs have enough edge cases (binary files, renames, mode changes, hunk headers) that writing a parser from scratch is a week of work for no benefit. parse-diff handles all of this and gives back a clean array of files with line numbers — exactly what Octokit needs to post inline comments.

**Redis for job processing and rate limiting, not a database**

Redis (Upstash) is used for both BullMQ job processing and rate limiting. To prevent a single repo from draining API credits I rate limit at 10 reviews per repo per 24 hours. Redis handles this with a simple INCR + EXPIRE — no database needed. Adding PostgreSQL just for this would be unnecessary infrastructure. There is a TTL safety net so a failed `EXPIRE` after `INCR` can't leave a key alive forever and lock a repo out permanently.

**Separate Redis connections for Queue and Worker**

BullMQ explicitly warns against sharing one Redis instance between the Queue and the Worker: the Queue uses normal command connections while the Worker needs a blocking connection with `maxRetriesPerRequest: null`. Sharing one caused subtle worker stalls. The queue now receives connection options and each side builds its own connection.

---

## Treating LLM Output as Untrusted Input

The model's response goes straight toward the GitHub API, so it is validated like any other external input:

- **Fence stripping and safe parsing.** Responses wrapped in markdown fences or with trailing commas used to throw inside `JSON.parse`, get swallowed, and report "no issues found". Fences are now stripped, parsing is guarded, and the result is checked against the expected shape at runtime.
- **Invalid output is not reported as clean code.** Individual review objects that fail validation are dropped, and if the model returns findings but none are valid, the PR gets a warning instead of an "all clear".
- **Type guard on every review.** `file`, `line`, and `severity` are validated before use, and file paths the model hallucinated are checked against the PR's actual changed files so comments never target files that don't exist.
- **Prompt explains the diff format.** The chunker marks removed lines with `OLD:`, but the prompt never said so, and the model commented on lines that no longer exist, which GitHub rejects with a 422. The prompt now explains the format, and `temperature` is set low for consistent structured JSON.

---

## Reliability Details

- **Per-comment posting.** Originally the whole review was posted in one call, so a single bad line number from the model made GitHub reject every comment. Comments are now posted individually with error handling, so one bad line costs one comment, not the whole review.
- **Honest summary.** The summary table reports both issues *found* and comments *posted*, so it never overstates what's visible on the PR.
- **Full file list via pagination.** GitHub's PR files endpoint returns 30 files per page; PRs touching more than that used to fail silently. The worker now pages through all of them.
- **No N+1 calls.** The PR's head SHA is fetched once per review, not once per comment. That also pins every comment to the same commit even if someone pushes mid-review.
- **Strict job validation.** Job payloads are validated before use (including `installationId === 0` handled correctly). Malformed jobs now throw so BullMQ retries or fails them visibly, instead of being marked completed and silently dropped.
- **Non-retryable errors** (e.g. a revoked installation) are classified in one shared helper, so they fail fast instead of retrying pointlessly.
- **Lazy AI client.** The Groq/OpenAI client is created on first use, not at import time, avoiding boot failures when env vars haven't loaded yet.
- **Cleaner logs.** Infra details like the Redis host and port no longer print in production, and error logs include the PR number.

---

## Bugs I Found in My Own Code

After the first working version I audited the whole codebase and fixed 48 issues across the webhook handler, AI layer, chunker, worker, Redis setup, and TypeScript config. The ones that mattered most:

1. **No signature verification** — a real security hole, now closed.
2. **All-or-nothing comment posting** — one bad line number killed the whole review.
3. **The chunker mixed files in one prompt** — it appended one file's hunks to another file's chunk, violating the "never mix files" rule. Chunks are now strictly per-file.
4. **Shared Redis connection** between Queue and Worker, causing subtle worker stalls.
5. **Webhook timeouts** — the server awaited several GitHub API calls before responding, so GitHub could time out and retry, producing duplicate reviews. It now acknowledges first.

Most of the rest were type-safety and hygiene fixes (missing `@types/node`, implicit `any`s, untyped Octokit) plus smaller correctness issues like a rate-limit window that disagreed with the docs.

---

## What I Used AI For

**AI-assisted:**
- Initial BullMQ boilerplate (queue setup, worker registration) — I understood the pattern then rewrote most of it
- Iterating on the review prompt template — I used AI to generate variations and picked the one that returned the most consistent structured JSON
- Render deployment and environment variable configuration — AI helped troubleshoot deployment issues while I configured and verified the production setup

**Written by hand:**
- Core webhook handler and signature verification logic — security-sensitive, didn't trust AI output here
- Diff chunking algorithm — this is the main interview talking point, needed to understand every line
- GitHub App JWT authentication flow — too easy to get subtly wrong with AI
- Rate limiting logic in Redis
- All deployment and Docker configuration

**Where I overrode AI suggestions:**
- AI kept suggesting to process reviews synchronously "for simplicity." Wrong — would cause webhook timeouts on any real PR
- AI suggested naive line-count chunking for diffs. Replaced with file-scoped, token-aware chunking after reasoning through the context contamination problem
- AI-generated error handling was too broad (catch-all try/catch everywhere). Replaced with specific error types so failures are debuggable

---

## What I'd Change With 4 More Weeks

**Repo-level RAG** is the most impactful addition. Right now CodeSentinel only sees what changed in the diff. If a function signature changes it doesn't know 5 other files call that function. With repo-level RAG — embedding the codebase into a vector database and retrieving related code at review time — it would catch cross-file issues that diff-only review misses entirely.

**A lightweight dashboard** showing review history per repo, aggregate issue patterns across PRs (how many security issues this month, which files get flagged most), and a manual re-review button. Right now everything happens inside GitHub with no visibility outside of individual PRs.

**Per-repo prompt calibration** — let repo owners specify their stack, coding standards, and what to focus on (security, performance, style). Right now the prompt is generic. A TypeScript repo and a Python ML repo need different review criteria.

**Accurate token counting.** The GPT-2 tokenizer is only a proxy, so the token limit carries a safety margin that wastes some capacity. Counting with the model's real tokenizer would let chunks be packed tighter.
