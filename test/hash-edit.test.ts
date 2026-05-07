import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import hashAnchoredEdit from "../index.ts";

let completedCases = 0;
process.on("exit", () => {
  assert.equal(completedCases, 5);
});

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  details: Record<string, any>;
};

type Tool = {
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: { cwd: string },
  ) => Promise<ToolResult>;
  renderResult?: (...args: any[]) => any;
};

function registerTools(): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  hashAnchoredEdit({
    registerTool(tool: Tool & { name: string }) {
      tools[tool.name] = tool;
    },
    registerCommand() {},
  } as any);
  return tools;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hash-edit-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function textContent(result: ToolResult): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function hashLine(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex").slice(0, 4);
}

function pos(lineNo: number, line: string): string {
  return `${String(lineNo).padStart(4, "0")}#${hashLine(line)}`;
}

test("read emits compact 4-char hash anchors", async () => {
  const tools = registerTools();
  await withTempDir(async (dir) => {
    const path = join(dir, "sample.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");

    const result = await tools.read.execute(
      "read-1",
      { path, limit: 3 },
      undefined,
      undefined,
      { cwd: dir },
    );

    assert.equal(result.details.hashLength, 4);
    assert.match(textContent(result), /^0001#[0-9a-f]{4}\|alpha$/m);
    assert.match(textContent(result), /^0002#[0-9a-f]{4}\|beta$/m);
    completedCases++;
  });
});

test("read accepts utf8 non-ascii text", async () => {
  const tools = registerTools();
  await withTempDir(async (dir) => {
    const path = join(dir, "utf8.md");
    await writeFile(path, "标题\n你好，世界\n", "utf8");

    const result = await tools.read.execute(
      "read-utf8",
      { path, limit: 2 },
      undefined,
      undefined,
      { cwd: dir },
    );
    const output = textContent(result);

    assert.equal(result.details.binary, undefined);
    assert.doesNotMatch(output, /Binary or non-text/);
    assert.match(output, /^0001#[0-9a-f]{4}\|标题$/m);
    assert.match(output, /^0002#[0-9a-f]{4}\|你好，世界$/m);
    completedCases++;
  });
});

test("edit patches by pos and returns compact updated anchors", async () => {
  const tools = registerTools();
  await withTempDir(async (dir) => {
    const path = join(dir, "sample.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");

    const result = await tools.edit.execute(
      "edit-1",
      {
        path,
        edits: [
          {
            pos: pos(2, "beta"),
            op: "patch",
            old: "beta",
            new: "BET",
          },
        ],
      },
      undefined,
      undefined,
      { cwd: dir },
    );

    assert.equal(await readFile(path, "utf8"), "alpha\nBET\ngamma\n");
    const output = textContent(result);
    assert.match(output, /^--- Anchors 2-2 ---\n0002#[0-9a-f]{4}\|BET$/m);
    assert.doesNotMatch(output, /^Updated /m);
    assert.doesNotMatch(output, /Preview:/);
    assert.match(result.details.displayDiff, /^- beta$/m);
    assert.match(result.details.displayDiff, /^\+ BET$/m);
    completedCases++;
  });
});

test("edit rejects stale pos hashes before writing", async () => {
  const tools = registerTools();
  await withTempDir(async (dir) => {
    const path = join(dir, "stale.txt");
    const original = "alpha\nbeta\ngamma\n";
    await writeFile(path, original, "utf8");

    await assert.rejects(
      () =>
        tools.edit.execute(
          "edit-stale",
          {
            path,
            edits: [{ pos: "0002#0000", op: "replace", new: "changed" }],
          },
          undefined,
          undefined,
          { cwd: dir },
        ),
      /Hash mismatch/,
    );
    assert.equal(await readFile(path, "utf8"), original);
    completedCases++;
  });
});

test("read renderResult uses Pi write-style long output hint", async () => {
  const tools = registerTools();
  const result = {
    content: [
      {
        type: "text",
        text: Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n"),
      },
    ],
    details: {},
  };
  const theme = {
    fg(_name: string, text: string) {
      return text;
    },
  };

  const component = tools.read.renderResult!(
    result,
    { expanded: false },
    theme,
  );
  const rendered = component
    .render(120)
    .map((line: string) => line.trimEnd())
    .join("\n");

  assert.match(rendered, /\.\.\. \(2 more lines, 12 total, ctrl\+o to expand\)/);
  completedCases++;
});
