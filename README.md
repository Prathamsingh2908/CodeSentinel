# CodeSentinel

CodeSentinel is a GitHub App that automatically reviews pull requests using the GPT-OSS-120B model via the Groq API. When a pull request is opened, it fetches the diff, partitions it into token-aware chunks using file-level bin packing, sends each chunk to the model with a structured prompt, and posts the results as inline review comments on the exact changed lines — the same way a human reviewer would.

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

**3. Run in development**

```bash
npm run dev
```

To test webhooks locally use a tunnel (ngrok or Smee) and point your GitHub App webhook URL to the tunnel endpoint.

**4. Install the app on a repo**

Go to https://github.com/apps/code-sentinel1, click Install, select a repo. Open any PR — CodeSentinel will post review comments automatically.

---

## Architecture Decisions

**Async processing over synchronous**

The first decision was whether to process the review synchronously inside the webhook handler or offload it to a queue. GitHub expects a response within 10 seconds or it marks the webhook as failed and retries. LLM inference can take 10-30 seconds depending on diff size. The only real option was to return 200 immediately and process in the background. I used BullMQ + Redis for the queue — it handles retries, job persistence, and backpressure out of the box.

**Bin packing for diff chunking, not naive line splitting**

A large PR can have 3000+ changed lines across 30 files. Sending it all in one LLM call hits token limits. The naive solution — split every N lines — breaks context badly: a function definition ends up in chunk 1, its body in chunk 3, and the model loses the thread.

I used bin packing instead: never mix two files in the same prompt (file-level partitioning as a hard rule), then pack as many whole files as fit within the token budget before starting a new chunk. Git hunks naturally include surrounding context lines, so the model gets function signatures even without explicit boundary detection. Fewer API calls, better context, lower cost.

**parse-diff over manual diff parsing**

Git diffs have enough edge cases (binary files, renames, mode changes, hunk headers) that writing a parser from scratch is a week of work for no benefit. parse-diff handles all of this and gives back a clean array of files with line numbers — exactly what Octokit needs to post inline comments.

**Redis for rate limiting, not a database**

To prevent a single repo from draining API credits I rate limit at 10 reviews per repo per 24 hours. Redis handles this with a simple INCR + EXPIRE — no database needed. Adding PostgreSQL just for this would be unnecessary infrastructure.

---

## What I Used AI For

**AI-assisted:**
- Initial BullMQ boilerplate (queue setup, worker registration) — I understood the pattern then rewrote most of it
- Iterating on the review prompt template — I used AI to generate variations and picked the one that returned the most consistent structured JSON
- Railway deployment and environment variable configuration — AI helped troubleshoot deployment issues while I configured and verified the production setup

**Written by hand:**
- Core webhook handler and signature verification logic — security-sensitive, didn't trust AI output here
- Diff chunking and bin packing algorithm — this is the main interview talking point, needed to understand every line
- GitHub App JWT authentication flow — too easy to get subtly wrong with AI
- Rate limiting logic in Redis
- All deployment and Docker configuration

**Where I overrode AI suggestions:**
- AI kept suggesting to process reviews synchronously "for simplicity." Wrong — would cause webhook timeouts on any real PR
- AI suggested naive line-count chunking for diffs. Replaced with file-level bin packing after reasoning through the context contamination problem
- AI-generated error handling was too broad (catch-all try/catch everywhere). Replaced with specific error types so failures are debuggable

---

## What I'd Change With 4 More Weeks

**Repo-level RAG** is the most impactful addition. Right now CodeSentinel only sees what changed in the diff. If a function signature changes it doesn't know 5 other files call that function. With repo-level RAG — embedding the codebase into a vector database and retrieving related code at review time — it would catch cross-file issues that diff-only review misses entirely.

**A lightweight dashboard** showing review history per repo, aggregate issue patterns across PRs (how many security issues this month, which files get flagged most), and a manual re-review button. Right now everything happens inside GitHub with no visibility outside of individual PRs.

**Per-repo prompt calibration** — let repo owners specify their stack, coding standards, and what to focus on (security, performance, style). Right now the prompt is generic. A TypeScript repo and a Python ML repo need different review criteria.

