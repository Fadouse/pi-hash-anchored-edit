import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const HASH_LEN = 6;
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

/** Resolve a model-provided path against Pi's current working directory. */
function resolvePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Keep Windows files as CRLF, classic Mac as CR, and everything else as LF. */
function detectLineEnding(text: string): "\n" | "\r\n" | "\r" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  if (crlf >= lf && crlf >= cr && crlf > 0) return "\r\n";
  if (cr > lf && cr > 0) return "\r";
  return "\n";
}

function hasFinalNewline(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function joinLines(lines: string[], eol: string, finalNewline: boolean): string {
  return lines.join(eol) + (finalNewline ? eol : "");
}

function lineHash(line: string, len = HASH_LEN): string {
  return createHash("sha256").update(line, "utf8").digest("hex").slice(0, len);
}

function anchor(lineNo: number, line: string): string {
  return `${String(lineNo).padStart(6, "0")}#${lineHash(line)} | ${line}`;
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 32 && byte <= 126) continue;
    if (byte >= 0xc2) continue; // likely UTF-8 multibyte text
    suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

function normalizeNewText(text: string | undefined): string[] {
  if (text === undefined) return [];
  return splitLines(text);
}

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the text file to read (relative or absolute). Output lines include LINE#HASH anchors." }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)." })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of anchored lines to return." })),
});

const editItemSchema = Type.Object({
  line: Type.Number({ description: "1-based line number shown by read, e.g. 42 from '000042#a1b2c3 | ...'." }),
  hash: Type.String({ description: `First ${HASH_LEN} hex chars shown after # for that exact line.` }),
  mode: Type.Optional(Type.Union([
    Type.Literal("replace"),
    Type.Literal("delete"),
    Type.Literal("insert_before"),
    Type.Literal("insert_after"),
  ], { description: "Edit operation. Defaults to replace." })),
  newText: Type.Optional(Type.String({ description: "Replacement or inserted text. May contain multiple lines. Omit for delete." })),
}, { additionalProperties: false });

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the text file to edit (relative or absolute)." }),
  edits: Type.Array(editItemSchema, { description: "Hash-anchored line edits. Every edit is validated against the original file before writing." }),
  dryRun: Type.Optional(Type.Boolean({ description: "Validate and preview without writing." })),
}, { additionalProperties: false });

type EditMode = "replace" | "delete" | "insert_before" | "insert_after";
type HashEdit = { line: number; hash: string; mode?: EditMode; newText?: string };
type EditInput = { path: string; edits: HashEdit[]; dryRun?: boolean };

function prepareEditArguments(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const args = input as Record<string, unknown>;
  if (typeof args.edits === "string") {
    try { args.edits = JSON.parse(args.edits); } catch {}
  }
  return args;
}

function validateEditInput(input: EditInput): void {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("edits must contain at least one hash-anchored edit.");
  }
  const seen = new Set<number>();
  for (const edit of input.edits) {
    if (!Number.isInteger(edit.line) || edit.line < 1) throw new Error(`Invalid line: ${edit.line}`);
    if (!/^[0-9a-fA-F]{4,64}$/.test(edit.hash)) throw new Error(`Invalid hash for line ${edit.line}: ${edit.hash}`);
    if (seen.has(edit.line)) throw new Error(`Multiple edits target line ${edit.line}. Merge them into one operation.`);
    seen.add(edit.line);
    const mode = edit.mode ?? "replace";
    if ((mode === "replace" || mode === "insert_before" || mode === "insert_after") && edit.newText === undefined) {
      throw new Error(`${mode} on line ${edit.line} requires newText.`);
    }
  }
}

function makePreview(path: string, before: string[], after: string[], dryRun: boolean): string {
  const beforeCount = before.length;
  const afterCount = after.length;
  let first = 0;
  while (first < before.length && first < after.length && before[first] === after[first]) first++;
  let lastBefore = before.length - 1;
  let lastAfter = after.length - 1;
  while (lastBefore >= first && lastAfter >= first && before[lastBefore] === after[lastAfter]) {
    lastBefore--;
    lastAfter--;
  }
  const from = Math.max(0, first - 3);
  const toBefore = Math.min(before.length - 1, lastBefore + 3);
  const toAfter = Math.min(after.length - 1, lastAfter + 3);
  const lines = [`${dryRun ? "Dry run" : "Updated"} ${path}: ${beforeCount} -> ${afterCount} lines`, "", "Preview:"];
  for (let i = from; i <= toBefore; i++) lines.push(`- ${anchor(i + 1, before[i] ?? "")}`);
  for (let i = from; i <= toAfter; i++) lines.push(`+ ${anchor(i + 1, after[i] ?? "")}`);
  return lines.join("\n");
}

function collectUpdatedAnchors(edits: HashEdit[], after: string[]): string {
  const touched = new Set<number>();
  for (const edit of edits) {
    const mode = edit.mode ?? "replace";
    const insertedCount = normalizeNewText(edit.newText).length;
    if (mode === "delete") {
      // The deleted line has no new anchor. Return the line that shifted into its place.
      if (edit.line <= after.length) touched.add(edit.line);
      continue;
    }
    const firstLine = mode === "insert_after" ? edit.line + 1 : edit.line;
    const count = Math.max(1, insertedCount);
    for (let line = firstLine; line < firstLine + count && line <= after.length; line++) {
      touched.add(line);
    }
  }
  const anchors = [...touched].sort((a, b) => a - b).map((line) => anchor(line, after[line - 1] ?? ""));
  return anchors.length > 0 ? `Updated anchors:\n${anchors.join("\n")}` : "Updated anchors: none (only deleted lines at EOF).";
}
function stripAnchorMetadataForDisplay(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("[Hash anchors:"))
    .map((line) => line.replace(/^([+-] )?\d{6}#[0-9a-f]{4,64} \| /, "$1"))
    .join("\n");
}

function compactEditDisplay(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "Edit complete.";
  const applied = text.match(/Applied \d+ hash-anchored edit\(s\)\./)?.[0];
  const dryRun = text.includes("No file written.") ? "No file written." : undefined;
  return [firstLine, applied ?? dryRun].filter(Boolean).join("\n");
}

export default function hashAnchoredEdit(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read",
    label: "read#",
    description: `Read a text file with hash anchors. Each returned line is formatted as LINE#HASH | content where HASH is sha256(lineContent).slice(0, ${HASH_LEN}). Use these anchors with edit.`,
    promptSnippet: "Read text files with LINE#HASH anchors for safer edits",
    promptGuidelines: [
      `Use read before edit. Every editable line is returned as LINE#HASH | content.`,
      `When editing, copy the target line number and ${HASH_LEN}-char hash exactly into edit.edits[].`,
      "If edit reports a hash mismatch, read the file again and retry with fresh anchors.",
    ],
    parameters: readSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const path = params.path as string;
      const absolute = resolvePath(path, ctx?.cwd ?? process.cwd());
      await access(absolute, constants.R_OK);
      const buffer = await readFile(absolute);
      if (isLikelyBinary(buffer)) {
        return { content: [{ type: "text", text: `Binary or non-text file: ${path}. Hash-anchored read only inlines text files.` }], details: { path, binary: true, hashLength: HASH_LEN } };
      }
      const text = buffer.toString("utf8");
      const lines = splitLines(text);
      const start = Math.max(0, ((params.offset as number | undefined) ?? 1) - 1);
      if (start >= lines.length && lines.length > 0) throw new Error(`Offset ${start + 1} is beyond end of file (${lines.length} lines).`);
      const requestedLimit = params.limit as number | undefined;
      const maxByLimit = requestedLimit ?? DEFAULT_MAX_LINES;
      const selected: string[] = [];
      let bytes = 0;
      for (let i = start; i < lines.length && selected.length < maxByLimit; i++) {
        const out = anchor(i + 1, lines[i]);
        const nextBytes = bytes + Buffer.byteLength(out, "utf8") + 1;
        if (selected.length > 0 && nextBytes > DEFAULT_MAX_BYTES) break;
        selected.push(out);
        bytes = nextBytes;
      }
      const end = start + selected.length;
      let output = selected.join("\n");
      if (end < lines.length) output += `\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`;
      return { content: [{ type: "text", text: output }], details: { path, lineCount: lines.length, hashLength: HASH_LEN, anchored: true } };
    },
    renderResult(result) {
      const raw = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("\n") ?? "";
      return new Text(stripAnchorMetadataForDisplay(raw), 0, 0);
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit#",
    description: "Edit a text file using line-number + sha256 hash anchors from read. This replaces Pi's built-in exact-text edit. Every change is validated against current file content before writing.",
    promptSnippet: "Make hash-anchored line edits using anchors from read",
    promptGuidelines: [
      "Use edit only with anchors obtained from the latest read output.",
      "Each edit must include line and hash. Do not guess hashes.",
      "Use mode=replace/delete/insert_before/insert_after. newText may contain multiple lines.",
      "On hash mismatch, read again instead of forcing the edit.",
    ],
    parameters: editSchema,
    prepareArguments: prepareEditArguments as any,
    async execute(_toolCallId, input: EditInput, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");
      validateEditInput(input);
      const absolute = resolvePath(input.path, ctx?.cwd ?? process.cwd());
      await access(absolute, constants.R_OK | constants.W_OK);
      const raw = await readFile(absolute, "utf8");
      const eol = detectLineEnding(raw);
      const finalNewline = hasFinalNewline(raw);
      const lines = splitLines(raw);

      // Validate every anchor before mutating any line.
      for (const edit of input.edits) {
        const current = lines[edit.line - 1];
        if (current === undefined) throw new Error(`Line ${edit.line} is beyond end of file (${lines.length} lines).`);
        const actual = lineHash(current, edit.hash.length);
        if (actual.toLowerCase() !== edit.hash.toLowerCase()) {
          throw new Error(`Hash mismatch at line ${edit.line}: expected ${edit.hash}, current ${actual}. Re-read the file and retry with fresh anchors.`);
        }
      }

      const next = [...lines];
      const ordered = [...input.edits].sort((a, b) => b.line - a.line);
      for (const edit of ordered) {
        const index = edit.line - 1;
        const mode = edit.mode ?? "replace";
        const newLines = normalizeNewText(edit.newText);
        if (mode === "replace") next.splice(index, 1, ...newLines);
        else if (mode === "delete") next.splice(index, 1);
        else if (mode === "insert_before") next.splice(index, 0, ...newLines);
        else if (mode === "insert_after") next.splice(index + 1, 0, ...newLines);
        else throw new Error(`Unsupported edit mode: ${mode}`);
      }

      const preview = makePreview(input.path, lines, next, input.dryRun === true);
      const updatedAnchors = collectUpdatedAnchors(input.edits, next);
      if (!input.dryRun) await writeFile(absolute, joinLines(next, eol, finalNewline), "utf8");
      return {
        content: [{ type: "text", text: `${preview}\n\n${updatedAnchors}\n\n${input.dryRun ? "No file written." : `Applied ${input.edits.length} hash-anchored edit(s).`}` }],
        details: { path: input.path, edits: input.edits.length, dryRun: input.dryRun === true, hashLength: HASH_LEN, updatedAnchors },
      };
    },
    renderResult(result) {
      const raw = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("\n") ?? "";
      return new Text(compactEditDisplay(raw), 0, 0);
    },
  });

  pi.registerCommand("hash-edit-status", {
    description: "Show hash-anchored read/edit replacement status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Hash-anchored read/edit active. Hash length: ${HASH_LEN}.`, "info");
    },
  });
}
