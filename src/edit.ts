import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { loadPromptGuidelines } from "./prompts.ts";
import {
  anchor,
  CHANGED_ANCHOR_TEXT_BUDGET_BYTES,
  compactPreview,
  detectLineEnding,
  HASH_LEN,
  hasFinalNewline,
  joinLines,
  lineHash,
  makeDisplayDiff,
  normalizeNewText,
  resolvePath,
  splitLines,
  styleDiff,
} from "./shared.ts";

const editItemSchema = Type.Object(
  {
    pos: Type.String({
      description: "LINE#HASH anchor shown by read, e.g. 0002#ab12.",
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

function editBoxBg(theme: any, context: any) {
  if (!context.executionStarted)
    return (text: string) => theme.bg("toolPendingBg", text);
  return context.isError
    ? (text: string) => theme.bg("toolErrorBg", text)
    : (text: string) => theme.bg("toolSuccessBg", text);
}

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

export function registerEditTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit#",
    description:
      "Edit a text file using LINE#HASH positions from read. Each pos must match the current line before writing.",
    promptSnippet: "Make hash-anchored line edits using anchors from read",
    promptGuidelines: loadPromptGuidelines("edit.md"),
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
          next[index] = next[index].replace(edit.old ?? "", edit.new ?? "");
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
}
