import OpenAI from 'openai';
import 'dotenv/config';

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

export async function analyzeCode(diffChunk: string) {
  const prompt = `
  You are a Senior Engineer. Review this diff. 
  Each line is prefixed with "LX" where X is the absolute line number.
  
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
    const response = await client.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const content = JSON.parse(response.choices[0]?.message.content || '{"reviews": []}');
    return content.reviews || [];
  } catch (error) {
    console.error("🤖 AI Analysis Error:", error);
    return [];
  }
}