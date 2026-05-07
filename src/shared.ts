import { getKeybindings } from "@mariozechner/pi-tui";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";

export const HASH_LEN = 4;
export const DEFAULT_MAX_LINES = 400;
export const DEFAULT_MAX_BYTES = 32 * 1024;
export const CHANGED_ANCHOR_TEXT_BUDGET_BYTES = 2048;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Resolve a model-provided path against Pi's current working directory. */
export function resolvePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Keep Windows files as CRLF, classic Mac as CR, and everything else as LF. */
export function detectLineEnding(text: string): "\n" | "\r\n" | "\r" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  if (crlf >= lf && crlf >= cr && crlf > 0) return "\r\n";
  if (cr > lf && cr > 0) return "\r";
  return "\n";
}

export function hasFinalNewline(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}

export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function joinLines(
  lines: string[],
  eol: string,
  finalNewline: boolean,
): string {
  return lines.join(eol) + (finalNewline ? eol : "");
}

export function lineHash(line: string, len = HASH_LEN): string {
  return createHash("sha256").update(line, "utf8").digest("hex").slice(0, len);
}

export function anchor(lineNo: number, line: string): string {
  return `${String(lineNo).padStart(4, "0")}#${lineHash(line)}|${line}`;
}

export function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  let text: string;
  try {
    text = utf8Decoder.decode(buffer);
  } catch {
    return true;
  }
  if (text.length === 0) return false;

  let suspicious = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const allowedWhitespace = code === 9 || code === 10 || code === 13;
    const control = code < 32 || (code >= 127 && code <= 159);
    if (control && !allowedWhitespace) suspicious++;
  }
  return suspicious / text.length > 0.3;
}

export function normalizeNewText(text: string | undefined): string[] {
  if (text === undefined) return [];
  return splitLines(text);
}

export function formatLineRange(args: any, theme: any): string {
  if (args?.offset === undefined && args?.limit === undefined) return "";
  const startLine = args.offset ?? 1;
  const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
  return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

export function compactPreview(
  text: string,
  expanded: boolean,
  theme: any,
): string {
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

export function stripAnchorMetadataForDisplay(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("[Hash anchors:"))
    .map((line) => line.replace(/^([+-] )?\d{4,}#[0-9a-f]{4,64}\|/, "$1"))
    .join("\n");
}

export function makeDisplayDiff(before: string[], after: string[]): string {
  const { from, toBefore, toAfter } = diffWindow(before, after);
  const lines: string[] = [];
  for (let i = from; i <= toBefore; i++) lines.push(`- ${before[i] ?? ""}`);
  for (let i = from; i <= toAfter; i++) lines.push(`+ ${after[i] ?? ""}`);
  return lines.join("\n");
}

export function styleDiff(diff: string, theme: any): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
      if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
      return theme.fg("toolDiffContext", line);
    })
    .join("\n");
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
