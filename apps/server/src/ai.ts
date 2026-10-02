import OpenAI from 'openai';
import 'dotenv/config';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is missing from environment variables');
    }
    client = new OpenAI({
      apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  return client;
}

export type Severity = 'CRITICAL' | 'MEDIUM' | 'LOW';

export interface AIReview {
  file: string;
  line: number;
  endLine?: number;
  severity: Severity;
  comment: string;
}

export async function analyzeCode(diffChunk: string): Promise<AIReview[]> {
  const prompt = `
  You are a Senior Engineer. Review this diff.
  Each line is prefixed with "LX" where X is the absolute line number.
  Lines prefixed with "OLD:" are removed lines. Do NOT comment on them.
  Only comment on lines prefixed with L<number>.
  Use the number directly after L as the line value.

  CATEGORIZATION RULES:
  - CRITICAL: Security vulnerabilities (leaked keys, SQLi), logic that CRASHES the app, or major data loss risks.
  - MEDIUM: Performance issues (N+1 queries), missing error handling, or bad architectural patterns.
  - LOW: Readability improvements, naming conventions, or minor best practices.

  JSON Format:
  {
    "reviews": [
      {
        "file": "string",
        "line": number,
        "endLine": number,
        "severity": "CRITICAL" | "MEDIUM" | "LOW",
        "comment": "string"
      }
    ]
  }

  Diff:
  ${diffChunk}
`;

  try {
    const response = await getClient().chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const raw = response.choices[0]?.message.content ?? '{"reviews": []}';

    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    let parsed: { reviews?: unknown };
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('🤖 Failed to parse AI JSON:', parseErr);
      console.error('Raw content was:', raw.slice(0, 500));
      return [];
    }

    return (Array.isArray(parsed.reviews) ? parsed.reviews : []) as AIReview[];
  } catch (error) {
    console.error("🤖 AI Analysis Error:", error);
    return [];
  }
}