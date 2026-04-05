Task 37-41: Phase 5 — AI Intelligence (all 5 tasks).

Read AGENTS.md for rules. Read ALL src/ files to understand the current codebase.

## Task 37: LLM Memory Compression
File: src/core/compression.ts

Export class CompressionService:
  - constructor(repository: Repository, config: VegaConfig)
  
  - async compressMemory(memoryId: string): Promise<{original_length: number, compressed_length: number}>
    1. Get memory by ID
    2. If content length < 500 chars, skip (too short to compress)
    3. Call Ollama chat API: POST {ollamaBaseUrl}/api/chat with model=config.ollamaModel
       System prompt: "Summarize the following technical note into a concise version. Keep all key facts, decisions, error messages, and solutions. Remove redundancy and filler. Output ONLY the summary, no preamble."
       User message: memory.content
    4. If compressed version is shorter: update memory content with compressed version, regenerate embedding
    5. Save original as version history before updating
    6. Return lengths

  - async compressBatch(project?: string, minLength?: number): Promise<{processed: number, compressed: number, saved_chars: number}>
    Find all active memories with content.length > (minLength || 1000)
    Compress each, track stats

  Note: Use native fetch to call Ollama /api/chat. Handle timeouts (30s). If Ollama unavailable, skip gracefully.

Add CLI command: vega compress [--project p] [--min-length 1000] [--dry-run]
Add MCP tool: memory_compress — params: memory_id?(string), project?(string)

## Task 38: Smart Memory Extraction
File: src/core/extraction.ts

Export class ExtractionService:
  - constructor(config: VegaConfig)
  
  - async extractMemories(text: string, project: string): Promise<ExtractionCandidate[]>
    Use Ollama chat to analyze text and extract structured memories.
    System prompt: "Analyze the following conversation/text and extract distinct pieces of knowledge worth remembering. For each, provide: type (decision/pitfall/preference/task_state/project_context), title (short), content (the knowledge), and tags (keywords). Output as JSON array. Only extract actionable, durable knowledge — skip emotions, one-time queries, and common knowledge."
    User message: text
    Parse response as JSON array of ExtractionCandidate
    Fallback to empty array on parse failure

  ExtractionCandidate = { type: MemoryType, title: string, content: string, tags: string[] }

Integrate into session.ts sessionEnd():
  If Ollama available, use ExtractionService instead of keyword regex matching.
  Keep regex as fallback when Ollama unavailable.

## Task 39: Auto Project Documentation
File: src/core/doc-generator.ts

Export class DocGenerator:
  - constructor(repository: Repository)
  
  - generateProjectReadme(project: string): string
    Query all memories for project, organize by type:
    - Architecture decisions (type=decision)
    - Known pitfalls (type=pitfall)
    - Active tasks (type=task_state, status=active)
    - Project context (type=project_context)
    - Preferences (type=preference, scope=global)
    Format as markdown README with sections
  
  - generateDecisionLog(project: string): string
    List all decision memories chronologically with reasoning

  - generatePitfallGuide(project: string): string
    List all pitfalls grouped by tag with solutions

Add CLI command: vega generate-docs --project <p> [--output <dir>] [--type readme|decisions|pitfalls|all]

## Task 40: Memory Quality Scoring
File: src/core/quality.ts

Export class QualityService:
  - constructor(repository: Repository, config: VegaConfig)
  
  - scoreMemory(memory: Memory): QualityScore
    Score on 4 dimensions (0-1 each):
    - accuracy: verified=1.0, unverified=0.5, conflict=0.3, rejected=0.0
    - freshness: 1/(1 + daysSinceUpdate * 0.01)
    - usefulness: min(1, access_count / 10)
    - completeness: min(1, content.length / 200)
    Overall = accuracy*0.4 + freshness*0.2 + usefulness*0.2 + completeness*0.2
  
  - async scoreBatch(project?: string): Promise<{total: number, avg_score: number, low_quality: Memory[]}>
    Score all active memories, return stats and memories scoring < 0.3
  
  - async degradeLowQuality(threshold?: number): Promise<number>
    Find memories with score < (threshold || 0.3), reduce importance by 0.1
    Return count degraded

  QualityScore = { accuracy: number, freshness: number, usefulness: number, completeness: number, overall: number }

Add to types.ts. Add CLI: vega quality [--project p] [--degrade]

## Task 41: Conversation Context Learning (Passive Observation)
File: src/core/observer.ts

Export class ObserverService:
  - constructor(memoryService: MemoryService, config: VegaConfig)
  
  - async observeToolOutput(toolName: string, input: unknown, output: unknown, project: string): Promise<string | null>
    Analyze tool execution results for memorable patterns:
    - If tool is a shell command that failed (exit code != 0): extract as pitfall candidate
    - If tool output contains error messages: extract error pattern
    - If tool is a file write: note the file and its purpose
    Return memory ID if stored, null if not worth storing
  
  - shouldObserve(toolName: string): boolean
    Return true for: Shell, file write/edit tools
    Return false for: read-only tools, navigation

Register as optional hook in MCP server: after each tool call, if observer is enabled, call observeToolOutput.
Add config: observerEnabled: boolean (default false, opt-in)

## Tests:
File: src/tests/ai-intelligence.test.ts
- Test: CompressionService skips short memories (< 500 chars)
- Test: ExtractionService returns empty array when Ollama unavailable
- Test: DocGenerator.generateProjectReadme produces valid markdown with sections
- Test: DocGenerator.generateDecisionLog lists decisions chronologically
- Test: QualityService.scoreMemory returns correct score for verified memory
- Test: QualityService.scoreMemory returns low score for rejected memory
- Test: QualityService.degradeLowQuality reduces importance
- Test: ObserverService.shouldObserve returns true for Shell

After all:
  npx tsc
  node --test dist/tests/ai-intelligence.test.js
  node --test dist/tests/*.test.js

Then commit:
  git add -A && git commit -m "feat: Phase 5 — LLM compression, smart extraction, doc generation, quality scoring, passive observer"
  git push origin main
