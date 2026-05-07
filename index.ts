import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Box, Container, getKeybindings, Spacer, Text } from "@mariozechner/pi-tui";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const HASH_LEN = 4;
const DEFAULT_MAX_LINES = 400;
const DEFAULT_MAX_BYTES = 32 * 1024;
const CHANGED_ANCHOR_TEXT_BUDGET_BYTES = 2048;

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

function joinLines(
  lines: string[],
  eol: string,
  finalNewline: boolean,
): string {
  return lines.join(eol) + (finalNewline ? eol : "");
}

function lineHash(line: string, len = HASH_LEN): string {
  return createHash("sha256").update(line, "utf8").digest("hex").slice(0, len);
}

function anchor(lineNo: number, line: string): string {
  return `${String(lineNo).padStart(4, "0")}#${lineHash(line)}|${line}`;
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

function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

function keyHint(theme: any, keybinding: string, description: string): string {
  const keys = getKeybindings().getKeys(keybinding);
  const keyText = Array.isArray(keys) ? keys.join("/") : String(keys ?? "");
  const displayKey = keyText || "ctrl+o";
  return theme.fg("dim", displayKey) + theme.fg("muted", ` ${description}`);
}

const readSchema = Type.Object({
  path: Type.String({
    description:
      "Path to the text file to read (relative or absolute). Output lines include LINE#HASH anchors.",
  }),
  offset: Type.Optional(
    Type.Number({
      description: "Line number to start reading from (1-indexed).",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of anchored lines to return." }),
  ),
});

const editItemSchema = Type.Object(
  {
    pos: Type.String({
      description: `LINE#HASH anchor shown by read, e.g. 0002#ab12.`,
    }),
    op: Type.Optional(
      Type.Union(
        [
          Type.Literal("replace"),
          Type.Literal("delete"),
          Type.Literal("before"),
          Type.Literal("after"),
          Type.Literal("patch"),
        ],
        { description: "Edit operation. Defaults to replace." },
      ),
    ),
    old: Type.Optional(
      Type.String({
        description:
          "Text to replace within the anchored line when op=patch. Must match exactly once.",
      }),
    ),
    new: Type.Optional(
      Type.String({
        description:
          "Replacement or inserted text. For op=patch, this is the replacement substring. May contain multiple lines except in patch op. Omit for delete.",
      }),
    ),
  },
  { additionalProperties: false },
);

const editSchema = Type.Object(
  {
    path: Type.String({
      description: "Path to the text file to edit (relative or absolute).",
    }),
    edits: Type.Array(editItemSchema, {
      description:
        "Hash-anchored line edits. Every edit is validated against the original file before writing.",
    }),
    dryRun: Type.Optional(
      Type.Boolean({ description: "Validate and preview without writing." }),
    ),
  },
  { additionalProperties: false },
);

type EditOp = "replace" | "delete" | "before" | "after" | "patch";
type PosEdit = {
  pos: string;
  op?: EditOp;
  old?: string;
  new?: string;
};
type EditInput = { path: string; edits: PosEdit[]; dryRun?: boolean };
type ResolvedEdit = PosEdit & {
  line: number;
  hash: string;
};
type AnchorRange = { start: number; end: number };

function prepareEditArguments(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const args = input as Record<string, unknown>;
  if (typeof args.edits === "string") {
    try {
      args.edits = JSON.parse(args.edits);
    } catch {}
  }
  return args;
}

function validateEditInput(input: EditInput): void {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("edits must contain at least one hash-anchored edit.");
  }
  const seen = new Set<string>();
  for (const edit of input.edits) {
    const { line, hash } = parsePos(edit.pos);
    const normalizedPos = `${line}#${hash.toLowerCase()}`;
    if (seen.has(normalizedPos))
      throw new Error(`Multiple edits target ${edit.pos}. Merge them.`);
    seen.add(normalizedPos);
    const op = edit.op ?? "replace";
    if (!["replace", "delete", "before", "after", "patch"].includes(op)) {
      throw new Error(`Unsupported edit op: ${op}`);
    }
    if (
      (op === "replace" || op === "before" || op === "after") &&
      edit.new === undefined
    ) {
      throw new Error(`${op} on ${edit.pos} requires new.`);
    }
    if (op === "patch") {
      if (edit.old === undefined)
        throw new Error(`patch on ${edit.pos} requires old.`);
      if (edit.new === undefined)
        throw new Error(`patch on ${edit.pos} requires new.`);
      if (
        edit.old.includes("\n") ||
        edit.old.includes("\r") ||
        edit.new.includes("\n") ||
        edit.new.includes("\r")
      ) {
        throw new Error(
          `patch on ${edit.pos} only supports single-line old/new.`,
        );
      }
    }
  }
}

function parsePos(pos: string): { line: number; hash: string } {
  const match = /^(\d+)#([0-9a-fA-F]{4,64})$/.exec(pos);
  if (!match) throw new Error(`Invalid pos: ${pos}`);
  const line = Number(match[1]);
  if (!Number.isInteger(line) || line < 1) throw new Error(`Invalid pos: ${pos}`);
  return { line, hash: match[2] };
}

function resolveEdits(edits: PosEdit[], lines: string[]): ResolvedEdit[] {
  return edits.map((edit) => {
    const { line, hash } = parsePos(edit.pos);
    const current = lines[line - 1];
    if (current === undefined) {
      throw new Error(
        `Line ${line} from ${edit.pos} is beyond end of file (${lines.length} lines).`,
      );
    }
    const actual = lineHash(current, hash.length);
    if (actual.toLowerCase() !== hash.toLowerCase()) {
      throw new Error(
        `Hash mismatch at ${edit.pos}: current line ${line} is ${line}#${actual}. Re-read the file and retry with fresh anchors.`,
      );
    }
    if ((edit.op ?? "replace") === "patch") {
      const oldText = edit.old ?? "";
      const occurrences =
        oldText === "" ? 0 : current.split(oldText).length - 1;
      if (occurrences !== 1)
        throw new Error(
          `Patch mismatch at ${edit.pos}: old must occur exactly once, found ${occurrences}.`,
        );
    }
    return { ...edit, line, hash };
  });
}

function diffWindow(before: string[], after: string[]) {
  let first = 0;
  while (
    first < before.length &&
    first < after.length &&
    before[first] === after[first]
  )
    first++;
  let lastBefore = before.length - 1;
  let lastAfter = after.length - 1;
  while (
    lastBefore >= first &&
    lastAfter >= first &&
    before[lastBefore] === after[lastAfter]
  ) {
    lastBefore--;
    lastAfter--;
  }
  const from = Math.max(0, first - 3);
  const toBefore = Math.min(before.length - 1, lastBefore + 3);
  const toAfter = Math.min(after.length - 1, lastAfter + 3);
  return { from, toBefore, toAfter };
}

function changedAnchorRange(
  edits: ResolvedEdit[],
  after: string[],
): AnchorRange | undefined {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  const include = (line: number) => {
    if (line < 1 || line > after.length) return;
    start = Math.min(start, line);
    end = Math.max(end, line);
  };
  for (const edit of edits) {
    const op = edit.op ?? "replace";
    const insertedCount =
      op === "patch" ? 1 : normalizeNewText(edit.new).length;
    if (op === "delete") {
      // The deleted line has no new anchor. Return the line that shifted into its place.
      include(edit.line);
      continue;
    }
    const firstLine = op === "after" ? edit.line + 1 : edit.line;
    const count = Math.max(1, insertedCount);
    for (
      let line = firstLine;
      line < firstLine + count && line <= after.length;
      line++
    ) {
      include(line);
    }
  }
  return Number.isFinite(start) ? { start, end } : undefined;
}

function formatHashlineRegion(lines: string[], startLine: number): string {
  return lines.map((line, i) => anchor(startLine + i, line)).join("\n");
}

function makeEditModelResult(
  after: string[],
  anchorRange: AnchorRange | undefined,
  dryRun: boolean,
): string {
  const suffix = dryRun ? "\nNo file written." : "";
  if (anchorRange) {
    const region = after.slice(anchorRange.start - 1, anchorRange.end);
    const formatted = formatHashlineRegion(region, anchorRange.start);
    const block = `--- Anchors ${anchorRange.start}-${anchorRange.end} ---\n${formatted}`;
    return Buffer.byteLength(block, "utf8") <= CHANGED_ANCHOR_TEXT_BUDGET_BYTES
      ? block + suffix
      : `Anchors omitted; use read for subsequent edits.${suffix}`;
  }
  return after.length === 0
    ? `File is empty.${suffix}`
    : `Anchors omitted; use read for subsequent edits.${suffix}`;
}
// TUI-only cleanup: preserve raw anchors for the model, but hide them from the human preview.
function stripAnchorMetadataForDisplay(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("[Hash anchors:"))
    .map((line) => line.replace(/^([+-] )?\d{4,}#[0-9a-f]{4,64}\|/, "$1"))
    .join("\n");
}

// Human-facing diff used by the custom edit TUI; raw edit results stay compact.
function makeDisplayDiff(before: string[], after: string[]): string {
  const { from, toBefore, toAfter } = diffWindow(before, after);
  const lines: string[] = [];
  for (let i = from; i <= toBefore; i++) lines.push(`- ${before[i] ?? ""}`);
  for (let i = from; i <= toAfter; i++) lines.push(`+ ${after[i] ?? ""}`);
  return lines.join("\n");
}

function formatLineRange(args: any, theme: any): string {
  if (args?.offset === undefined && args?.limit === undefined) return "";
  const startLine = args.offset ?? 1;
  const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
  return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

// Match Pi's write rendering: 10-line preview, total count, and dynamic expand key hint.
function compactPreview(text: string, expanded: boolean, theme: any): string {
  const lines = trimTrailingEmptyLines(text.replace(/\r/g, "").split("\n"));
  const totalLines = lines.length;
  const maxLines = expanded ? lines.length : 10;
  const shown = lines.slice(0, maxLines).map(replaceTabs).join("\n");
  const remaining = lines.length - maxLines;
  const suffix =
    remaining > 0
      ? `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint(theme, "app.tools.expand", "to expand")})`
      : "";
  return shown + suffix;
}
function styleDiff(diff: string, theme: any): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
      if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
      return theme.fg("toolDiffContext", line);
    })
    .join("\n");
}

function editBoxBg(theme: any, context: any) {
  if (!context.executionStarted)
    return (text: string) => theme.bg("toolPendingBg", text);
  return context.isError
    ? (text: string) => theme.bg("toolErrorBg", text)
    : (text: string) => theme.bg("toolSuccessBg", text);
}

// Render edit as one colored block. Pi supplies context.isError, so success turns green and failures red.
function buildEditBox(component: any, args: any, theme: any, context: any) {
  component.setBgFn(editBoxBg(theme, context));
  component.clear();
  const path = typeof args?.path === "string" ? args.path : "...";
  component.addChild(
    new Text(
      `${theme.fg("toolTitle", theme.bold("edit#"))} ${theme.fg("accent", path)}`,
      0,
      0,
    ),
  );
  const diff = context.state.displayDiff as string | undefined;
  const errorText = context.state.errorText as string | undefined;
  if (errorText) {
    component.addChild(new Spacer(1));
    component.addChild(new Text(theme.fg("error", errorText), 0, 0));
  }
  if (diff) {
    component.addChild(new Spacer(1));
    component.addChild(
      new Text(
        styleDiff(compactPreview(diff, context.expanded, theme), theme),
        0,
        0,
      ),
    );
  }
  return component;
}

export default function hashAnchoredEdit(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read",
    label: "read#",
    description: `Read text with LINE#HASH|content anchors; HASH is ${HASH_LEN} chars from sha256(lineContent).`,
    promptSnippet: "Read text files with LINE#HASH anchors for safer edits",
    promptGuidelines: [
      `Use read before edit. Every editable line is returned as LINE#HASH|content.`,
      `When editing, copy the target LINE#HASH into edit.edits[].pos.`,
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
        return {
          content: [
            {
              type: "text",
              text: `Binary or non-text file: ${path}. Hash-anchored read only inlines text files.`,
            },
          ],
          details: { path, binary: true, hashLength: HASH_LEN },
        };
      }
      const text = buffer.toString("utf8");
      const lines = splitLines(text);
      const start = Math.max(
        0,
        ((params.offset as number | undefined) ?? 1) - 1,
      );
      if (start >= lines.length && lines.length > 0)
        throw new Error(
          `Offset ${start + 1} is beyond end of file (${lines.length} lines).`,
        );
      const requestedLimit = params.limit as number | undefined;
      const maxByLimit = requestedLimit ?? DEFAULT_MAX_LINES;
      const selected: string[] = [];
      let bytes = 0;
      for (
        let i = start;
        i < lines.length && selected.length < maxByLimit;
        i++
      ) {
        const out = anchor(i + 1, lines[i]);
        const nextBytes = bytes + Buffer.byteLength(out, "utf8") + 1;
        if (selected.length > 0 && nextBytes > DEFAULT_MAX_BYTES) break;
        selected.push(out);
        bytes = nextBytes;
      }
      const end = start + selected.length;
      let output = selected.join("\n");
      if (end < lines.length)
        output += `\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`;
      return {
        content: [{ type: "text", text: output }],
        details: {
          path,
          lineCount: lines.length,
          hashLength: HASH_LEN,
          anchored: true,
        },
      };
    },
    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const path = typeof args?.path === "string" ? args.path : "...";
      text.setText(
        `${theme.fg("toolTitle", theme.bold("read#"))} ${theme.fg("accent", path)}${formatLineRange(args, theme)}`,
      );
      return text;
    },
    renderResult(result, options, theme) {
      const raw =
        result.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text ?? "")
          .join("\n") ?? "";
      const display = compactPreview(
        stripAnchorMetadataForDisplay(raw),
        options.expanded,
        theme,
      );
      return new Text(theme.fg("toolOutput", display), 0, 0);
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit#",
    description:
      "Edit a text file using LINE#HASH positions from read. Each pos must match the current line before writing.",
    promptSnippet: "Make hash-anchored line edits using anchors from read",
    promptGuidelines: [
      "Use edit only with anchors obtained from the latest read output.",
      "Each edit must include pos. Do not guess anchors.",
      "Use op=patch with old/new for small in-line replacements; old must occur exactly once on the anchored line.",
      "Use op=replace/delete/before/after for whole-line or multi-line edits.",
      "On hash mismatch, read again instead of forcing the edit.",
    ],
    parameters: editSchema,
    prepareArguments: prepareEditArguments as any,
    renderShell: "self",
    async execute(_toolCallId, input: EditInput, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");
      validateEditInput(input);
      const absolute = resolvePath(input.path, ctx?.cwd ?? process.cwd());
      await access(absolute, constants.R_OK | constants.W_OK);
      const raw = await readFile(absolute, "utf8");
      const eol = detectLineEnding(raw);
      const finalNewline = hasFinalNewline(raw);
      const lines = splitLines(raw);
      const resolved = resolveEdits(input.edits, lines);

      const next = [...lines];
      const ordered = [...resolved].sort((a, b) => b.line - a.line);
      for (const edit of ordered) {
        const index = edit.line - 1;
        const op = edit.op ?? "replace";
        const newLines = normalizeNewText(edit.new);
        if (op === "patch")
          next[index] = next[index].replace(
            edit.old ?? "",
            edit.new ?? "",
          );
        else if (op === "replace") next.splice(index, 1, ...newLines);
        else if (op === "delete") next.splice(index, 1);
        else if (op === "before") next.splice(index, 0, ...newLines);
        else if (op === "after") next.splice(index + 1, 0, ...newLines);
        else throw new Error(`Unsupported edit op: ${op}`);
      }

      const anchorRange = changedAnchorRange(resolved, next);
      const modelResult = makeEditModelResult(
        next,
        anchorRange,
        input.dryRun === true,
      );
      const displayDiff = makeDisplayDiff(lines, next);
      if (!input.dryRun)
        await writeFile(absolute, joinLines(next, eol, finalNewline), "utf8");
      return {
        content: [
          {
            type: "text",
            text: modelResult,
          },
        ],
        details: {
          path: input.path,
          edits: input.edits.length,
          dryRun: input.dryRun === true,
          hashLength: HASH_LEN,
          anchorRange,
          displayDiff,
        },
      };
    },
    renderCall(args, theme, context) {
      const component =
        (context.lastComponent as any) ?? new Box(1, 1, (text: string) => text);
      context.state.callComponent = component;
      return buildEditBox(component, args, theme, context);
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        context.state.errorText =
          result.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text ?? "")
            .join("\n") ?? "Edit failed.";
      } else {
        context.state.errorText = undefined;
      }
      if (typeof result.details?.displayDiff === "string")
        context.state.displayDiff = result.details.displayDiff;
      const component = context.state.callComponent as any;
      if (component) buildEditBox(component, context.args, theme, context);
      return new Container();
    },
  });

  pi.registerCommand("hash-edit-status", {
    description: "Show hash-anchored read/edit replacement status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Hash-anchored read/edit active. Hash length: ${HASH_LEN}.`,
        "info",
      );
    },
  });
}
