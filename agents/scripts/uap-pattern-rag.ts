/**
 * UAP Pattern RAG Middleware for OpenCode
 * 
 * This middleware queries the Qdrant vector database for task-relevant patterns
 * and injects them as context before each user prompt.
 * 
 * Equivalent to .factory/hooks/pattern-rag-prompt.sh for Factory Droid.
 * 
 * Setup: Add to opencode.json under "middleware" key
 * 
 * Requirements:
 * - Qdrant running on localhost:6333
 * - Patterns indexed via agents/scripts/index_patterns.py
 */

interface PatternResult {
  id: number | string;
  score: number;
  title: string;
  abbreviation: string;
  category: string;
  body: string;
}

const QDRANT_HOST = "localhost";
const QDRANT_PORT = 6333;
const COLLECTION_NAME = "agent_patterns";
const TOP_K = 2;
const MIN_SCORE = 0.35;

/**
 * Query Qdrant for relevant patterns using embedding-based search.
 */
async function queryPatterns(query: string): Promise<PatternResult[]> {
  try {
    const response = await fetch(`http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${COLLECTION_NAME}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: TOP_K,
        with_payload: true,
      }),
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json() as { result: { points: Array<{ id: number; score?: number; payload: Record<string, unknown> }> } };
    
    return data.result?.points?.slice(0, TOP_K).map((p) => ({
      id: p.id,
      score: p.score ?? 0.5,
      title: String(p.payload?.title ?? ""),
      abbreviation: String(p.payload?.abbreviation ?? ""),
      category: String(p.payload?.category ?? ""),
      body: String(p.payload?.body ?? ""),
    })) ?? [];
  } catch {
    return [];
  }
}

/**
 * Format patterns for context injection.
 */
function formatForContext(patterns: PatternResult[]): string {
  if (patterns.length === 0) {
    return "";
  }

  const lines = ["<uap-patterns>"];
  for (const p of patterns) {
    const abbr = p.abbreviation ? ` (${p.abbreviation})` : "";
    lines.push(`### Pattern ${p.id}: ${p.title}${abbr}`);
    lines.push(`Relevance: ${p.score.toFixed(3)}`);
    lines.push(p.body);
    lines.push("");
  }
  lines.push("</uap-patterns>");

  return lines.join("\n");
}

/**
 * Middleware entry point for OpenCode.
 * Called on UserPromptSubmit event.
 */
export async function middleware(context: {
  prompt: string;
}): Promise<{ additionalContext?: string }> {
  const { prompt } = context;

  if (prompt.length < 20) {
    return {};
  }

  const truncatedQuery = prompt.slice(0, 500);
  const patterns = await queryPatterns(truncatedQuery);
  const contextStr = formatForContext(patterns);
  
  if (contextStr) {
    return { additionalContext: contextStr };
  }

  return {};
}

export async function sessionStartPatterns(): Promise<string> {
  const patterns = await queryPatterns("coding agent best practices security");
  return formatForContext(patterns);
}

export default middleware;
