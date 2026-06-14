import { toRelativePath } from "./path-utils";

/**
 * Cursor CLI Review Agent — prompt, command builder, NDJSON stream reducer,
 * marker-block parser, and finding transformer.
 *
 * Cursor differs from Claude/Codex in exactly one way: its headless CLI
 * (the binary is literally named `agent`) exposes no schema-validation flag
 * (`--json-schema` / `--output-schema` / `structured_output`). Its final task
 * output is prose. That earns strict *parsing* — Cursor is told to emit a
 * marker-delimited JSON block, and we extract the LAST complete block from the
 * reconstructed canonical text. It does NOT earn extra isolation,
 * finding-policing, env scrubbing, or a per-job marker nonce. Cursor inherits
 * process.env like Claude/Codex; its read-only posture comes only from the
 * command flags (`--mode ask` + `--sandbox enabled` + no `--force`).
 *
 * Cursor `stream-json` is decoded with a real line-buffered NDJSON reducer
 * (pipe chunk boundaries are NOT NDJSON record boundaries), producing live log
 * deltas and the canonical assistant/result text used for marker extraction.
 */

// ---------------------------------------------------------------------------
// Static marker — v1 uses a STATIC marker plus last-block selection (no nonce).
// If testing shows the model echoing the marker from the prompt, add a per-job
// nonce then — not before (per approach doc §Structured Output Policy).
// ---------------------------------------------------------------------------

export const CURSOR_MARKER_OPEN = "<plannotator-review-json>";
export const CURSOR_MARKER_CLOSE = "</plannotator-review-json>";

// ---------------------------------------------------------------------------
// Types — mirror ClaudeFinding/ClaudeReviewOutput, plus a freeform summary.
// ---------------------------------------------------------------------------

export type CursorSeverity = "important" | "nit" | "pre_existing";

export interface CursorFinding {
  file: string;
  line: number;
  end_line: number;
  severity: CursorSeverity;
  description: string;
  reasoning: string;
}

export interface CursorReviewSummary {
  correctness: string;
  explanation: string;
  confidence: number;
}

export interface CursorReviewOutput {
  findings: CursorFinding[];
  summary: CursorReviewSummary;
}

const VALID_SEVERITIES: ReadonlySet<string> = new Set([
  "important",
  "nit",
  "pre_existing",
]);

// ---------------------------------------------------------------------------
// Schema validator — hand-rolled (no Ajv): Cursor output is prompt-enforced,
// so validation is the floor that turns prose back into a trusted object.
// ---------------------------------------------------------------------------

/**
 * Validate a parsed object against the Cursor review schema.
 * Returns the typed output, or null if the shape is invalid.
 *
 * Empty findings are valid as long as the JSON itself is valid and carries a
 * valid summary (per approach doc §Structured Output Policy).
 */
export function validateCursorReviewOutput(parsed: unknown): CursorReviewOutput | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.findings)) return null;

  const summary = obj.summary;
  if (!summary || typeof summary !== "object") return null;
  const s = summary as Record<string, unknown>;
  if (typeof s.correctness !== "string") return null;
  if (typeof s.explanation !== "string") return null;
  if (typeof s.confidence !== "number") return null;

  const findings: CursorFinding[] = [];
  for (const raw of obj.findings) {
    if (!raw || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>;
    if (typeof f.file !== "string") return null;
    if (typeof f.line !== "number") return null;
    if (typeof f.severity !== "string" || !VALID_SEVERITIES.has(f.severity)) return null;
    if (typeof f.description !== "string") return null;

    findings.push({
      file: f.file,
      line: f.line,
      end_line: typeof f.end_line === "number" ? f.end_line : f.line,
      severity: f.severity as CursorSeverity,
      description: f.description,
      reasoning: typeof f.reasoning === "string" ? f.reasoning : "",
    });
  }

  return {
    findings,
    summary: {
      correctness: s.correctness,
      explanation: s.explanation,
      confidence: s.confidence,
    },
  };
}

// ---------------------------------------------------------------------------
// Review prompt — mirrors CLAUDE_REVIEW_PROMPT, ending with the marker-block
// output contract (Cursor has no schema flag, so the contract is the prompt).
// ---------------------------------------------------------------------------

export const CURSOR_REVIEW_PROMPT = `# Cursor Code Review System Prompt

## Identity
You are a code review system. Your job is to find bugs that would break
production. You are not a linter, formatter, or style checker unless
project guidance files explicitly expand your scope.

## Pipeline

Step 1: Gather context
  - Retrieve the PR diff or local diff (gh pr diff, git diff, or jj diff)
  - Read CLAUDE.md and REVIEW.md at the repo root and in every directory
    containing modified files
  - Build a map of which rules apply to which file paths
  - Identify any skip rules (paths, patterns, or file types to ignore)

Step 2: Review for issues
  - Logic errors, regressions, broken edge cases, build failures, and code
    that will produce wrong results.
  - Security vulnerabilities with concrete exploit paths, race conditions, and
    incorrect assumptions about trust boundaries.
  - Code quality: unnecessary duplication, missed reuse of existing utilities,
    overly complex implementations a senior engineer would care about.
  - Guideline compliance: clear, unambiguous violations of CLAUDE.md / REVIEW.md
    where you can cite the exact rule broken. Respect all skip rules.

Step 3: Validate each candidate finding
  - Trace the actual code path to confirm the issue is real.
  - Check whether the issue is handled elsewhere (try/catch, upstream guard,
    fallback logic, type system guarantees).
  - If validation fails, drop the finding silently.
  - If validation passes, write a clear reasoning chain — this becomes the
    \`reasoning\` field.

Step 4: Classify each validated finding with exactly one severity:

  important — A bug that should be fixed before merging. Build failures, clear
    logic errors, security vulnerabilities with exploit paths, data loss risks,
    race conditions with observable consequences.

  nit — A minor issue worth fixing but non-blocking. Style deviations from
    project guidelines, code quality concerns, unlikely-but-worth-noting edge
    cases, convention violations that don't affect correctness.

  pre_existing — A bug that exists in the surrounding codebase but was NOT
    introduced by this change. Only flag when directly relevant to the changed
    code path.

## Hard constraints
- Never approve or block the change.
- Never comment on formatting or code style unless guidance files say to.
- Never flag missing test coverage unless guidance files say to.
- Never invent rules — only enforce what CLAUDE.md or REVIEW.md state.
- Prefer silence over false positives — when in doubt, drop the finding.
- Do NOT modify files. This is a read-only review.
- Do NOT post any comments to GitHub or GitLab. Do NOT use gh pr comment, glab,
  or any commenting tool.

## Output contract
Your only machine-readable output is a single marker-delimited JSON block.
Any natural-language commentary you write must come BEFORE the final marker
block. Emit the block exactly once, as the last thing in your response:

${CURSOR_MARKER_OPEN}
{
  "findings": [
    {
      "file": "packages/server/review.ts",
      "line": 123,
      "end_line": 123,
      "severity": "important",
      "description": "The issue...",
      "reasoning": "Why this is a real issue..."
    }
  ],
  "summary": {
    "correctness": "Issues Found",
    "explanation": "One important issue was found.",
    "confidence": 0.85
  }
}
${CURSOR_MARKER_CLOSE}

Schema:
- findings: array of objects, each with
  - file: string (path as shown in the diff)
  - line: integer (start line, post-change numbering)
  - end_line: integer (end line; equal to line for a single line)
  - severity: one of "important", "nit", "pre_existing"
  - description: string (one paragraph)
  - reasoning: string (how the issue was confirmed)
- summary: object with
  - correctness: string ("Correct" or "Issues Found")
  - explanation: string (one sentence)
  - confidence: number between 0 and 1

If no issues are found, return an empty "findings" array with a valid summary.`;

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

export interface CursorCommandResult {
  command: string[];
}

/**
 * Build the `agent -p` command. NOTE the binary is `agent`, NOT `cursor`.
 *
 * Read-only posture comes entirely from `--mode ask` + `--sandbox enabled` and
 * the absence of `--force`/`--yolo`. `--trust` is required in headless print
 * mode: without it Cursor stops on an interactive workspace-trust prompt that a
 * background job can never answer. It is safe here because the run is already
 * constrained to read-only ask mode with the sandbox enabled.
 *
 * The prompt is the trailing positional argument — `agent` reads task text from
 * argv (`[prompt...]`), not stdin. `--model` is omitted when the model is
 * `Auto`/empty so Cursor uses its default model selection. `--workspace` is set
 * to the launch cwd when provided, matching the spawn cwd.
 */
export function buildCursorCommand(prompt: string, model?: string, cwd?: string): CursorCommandResult {
  const useModel = !!model && model !== "Auto";

  return {
    command: [
      "agent",
      "-p",
      "--mode",
      "ask",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      ...(cwd ? ["--workspace", cwd] : []),
      "--sandbox",
      "enabled",
      ...(useModel ? ["--model", model] : []),
      // Prompt is the trailing positional arg — agent reads it from argv, not stdin.
      prompt,
    ],
  };
}

// ---------------------------------------------------------------------------
// Stream reduction — line-buffered NDJSON reducer.
// ---------------------------------------------------------------------------

interface CursorStreamEvent {
  type?: string;
  subtype?: string;
  timestamp_ms?: number;
  model_call_id?: string;
  message?: { content?: unknown };
  text?: string;
  [key: string]: unknown;
}

/**
 * A partial-output assistant event is a real new text delta only when
 * `timestamp_ms` is present AND `model_call_id` is absent. All other assistant
 * flushes are duplicate re-emissions (per approach doc §Log Streaming).
 */
function isRealAssistantDelta(event: CursorStreamEvent): boolean {
  return event.timestamp_ms !== undefined && event.model_call_id === undefined;
}

/** Pull readable text out of an assistant event's content (string or parts). */
function extractAssistantText(event: CursorStreamEvent): string {
  if (typeof event.text === "string") return event.text;
  const content = event.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type?: string; text?: string } => !!p && typeof p === "object")
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }
  return "";
}

export interface CursorStreamReduction {
  /** Canonical assistant/result text — the substrate for marker extraction. */
  canonicalText: string;
  /** Number of NDJSON records that parsed successfully. */
  recordCount: number;
}

/**
 * Reduce a complete Cursor `stream-json` stdout buffer into canonical text.
 *
 * Critically line-buffered: only complete lines (terminated by `\n`) are parsed.
 * A trailing partial line with no newline is treated as complete (the process
 * has exited by the time this runs on the accumulated buffer), but mid-stream
 * chunk boundaries never corrupt a record because we join the whole buffer
 * before splitting on newlines.
 */
export function reduceCursorStreamEvents(stdout: string): CursorStreamReduction {
  let canonicalText = "";
  let recordCount = 0;

  if (!stdout) return { canonicalText, recordCount };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: CursorStreamEvent;
    try {
      event = JSON.parse(line) as CursorStreamEvent;
    } catch {
      continue; // not a complete/valid NDJSON record — skip
    }
    recordCount++;

    if (event.type === "assistant") {
      // For partial streaming, only append real new deltas. If no event in the
      // stream carries timestamp_ms (partial streaming disabled), append the
      // full assistant text once.
      if (event.timestamp_ms !== undefined) {
        if (isRealAssistantDelta(event)) canonicalText += extractAssistantText(event);
      } else if (event.model_call_id === undefined) {
        canonicalText += extractAssistantText(event);
      }
    } else if (event.type === "result") {
      const resultText =
        typeof event.result === "string"
          ? event.result
          : typeof event.text === "string"
            ? event.text
            : "";
      if (resultText) canonicalText += resultText;
    }
  }

  return { canonicalText, recordCount };
}

// ---------------------------------------------------------------------------
// Marker-block parsing — reduce → take the LAST complete marker block → parse →
// schema-validate. Returns null on any failure (caller fails the job).
// ---------------------------------------------------------------------------

/** Extract the content of the LAST complete marker block from canonical text. */
function extractLastMarkerBlock(text: string): string | null {
  let result: string | null = null;
  let searchFrom = 0;

  while (true) {
    const open = text.indexOf(CURSOR_MARKER_OPEN, searchFrom);
    if (open === -1) break;
    const contentStart = open + CURSOR_MARKER_OPEN.length;
    const close = text.indexOf(CURSOR_MARKER_CLOSE, contentStart);
    if (close === -1) break; // no matching close — block is incomplete
    result = text.slice(contentStart, close);
    searchFrom = close + CURSOR_MARKER_CLOSE.length;
  }

  return result;
}

/**
 * Parse Cursor `stream-json` stdout into a validated review output.
 *
 * Pipeline: line-buffered NDJSON reduce → reconstruct canonical text → take the
 * LAST complete marker block → JSON.parse → schema-validate. Returns null on
 * ANY failure (missing marker, malformed JSON, schema mismatch) so the caller
 * can fail the job.
 */
export function parseCursorStreamOutput(stdout: string): CursorReviewOutput | null {
  if (!stdout || !stdout.trim()) return null;

  const { canonicalText } = reduceCursorStreamEvents(stdout);
  if (!canonicalText) return null;

  const block = extractLastMarkerBlock(canonicalText);
  if (block === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block.trim());
  } catch {
    return null;
  }

  return validateCursorReviewOutput(parsed);
}

// ---------------------------------------------------------------------------
// Live log formatter — maps one NDJSON event to a readable log line.
// ---------------------------------------------------------------------------

/**
 * Format one Cursor `stream-json` line for the LiveLogViewer.
 * Returns a human-readable string, or null if the line should be skipped.
 *
 * Mirrors formatClaudeLogEvent. Applies the same partial-output dedup rule as
 * the reducer: an assistant delta is shown only when `timestamp_ms` is present
 * and `model_call_id` is absent.
 */
export function formatCursorLogEvent(line: string): string | null {
  let event: CursorStreamEvent;
  try {
    event = JSON.parse(line) as CursorStreamEvent;
  } catch {
    return null;
  }

  switch (event.type) {
    case "system": {
      if (event.subtype === "init") {
        const model = typeof event.model === "string" ? event.model : undefined;
        const sessionId = typeof event.session_id === "string" ? event.session_id : undefined;
        const bits = ["[init]"];
        if (model) bits.push(`model=${model}`);
        if (sessionId) bits.push(`session=${sessionId}`);
        return bits.join(" ");
      }
      return null;
    }
    case "assistant": {
      // We always launch with --stream-partial-output, so the only assistant
      // events worth showing live are real new deltas (timestamp_ms present,
      // model_call_id absent). Everything else repeats already-streamed text:
      // pre-tool-call duplicate flushes (model_call_id present) and the final
      // buffered flush at end of turn (no timestamp_ms). Skip both.
      if (!isRealAssistantDelta(event)) return null;
      const text = extractAssistantText(event);
      return text ? text : null;
    }
    case "tool_call": {
      const name = typeof event.name === "string" ? event.name : "tool";
      if (event.subtype === "completed") {
        return `[${name}] completed`;
      }
      // started (or unspecified) — show concise args, never full file contents.
      const args =
        typeof event.args === "string"
          ? event.args.slice(0, 100)
          : event.args !== undefined
            ? JSON.stringify(event.args).slice(0, 100)
            : "";
      return `[${name}] ${args}`.trimEnd();
    }
    case "result": {
      const duration =
        typeof event.duration_ms === "number" ? `${event.duration_ms}ms` : undefined;
      const requestId = typeof event.request_id === "string" ? event.request_id : undefined;
      const bits = ["[result]"];
      if (duration) bits.push(duration);
      if (requestId) bits.push(`request=${requestId}`);
      return bits.length > 1 ? bits.join(" ") : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Finding transform — Cursor findings → external annotations.
// Identical shape to transformClaudeFindings, with author "Cursor".
// ---------------------------------------------------------------------------

export interface CursorReviewAnnotationInput {
  source: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  type: string;
  side: string;
  scope: string;
  text: string;
  severity: CursorSeverity;
  reasoning: string;
  author: string;
}

/** Transform Cursor findings into the external annotation format. */
export function transformCursorFindings(
  findings: CursorFinding[],
  source: string,
  cwd?: string,
  pathTransform?: (path: string) => string,
): CursorReviewAnnotationInput[] {
  return findings
    .filter((f) => f.file && typeof f.line === "number")
    .map((f) => ({
      source,
      filePath: pathTransform
        ? pathTransform(toRelativePath(f.file, cwd))
        : toRelativePath(f.file, cwd),
      lineStart: f.line,
      lineEnd: f.end_line ?? f.line,
      type: "comment",
      side: "new",
      scope: "line",
      text: `[${f.severity}] ${f.description}`,
      severity: f.severity,
      reasoning: f.reasoning,
      author: "Cursor",
    }));
}
