import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { Type } from "typebox";
import { loadPromptGuidelines } from "./prompts.ts";
import {
  anchor,
  compactPreview,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatLineRange,
  HASH_LEN,
  isLikelyBinary,
  resolvePath,
  splitLines,
  stripAnchorMetadataForDisplay,
} from "./shared.ts";

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

export function registerReadTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read",
    label: "read#",
    description: `Read text with LINE#HASH|content anchors; HASH is ${HASH_LEN} chars from sha256(lineContent).`,
    promptSnippet: "Read text files with LINE#HASH anchors for safer edits",
    promptGuidelines: loadPromptGuidelines("read.md"),
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
}
