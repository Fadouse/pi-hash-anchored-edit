# Hash-Anchored Edit for Pi

Safer `read`/`edit` replacement tools for [Pi](https://pi.dev/) coding agent. Each line returned by `read` includes a short SHA-256 content hash, and every `edit` must present the matching `LINE#HASH` position before the file is written.

![Hash edit preview](./assets/hash-edit-preview.png)

## Why this exists

Agentic coding often fails because context goes stale: line numbers drift, exact text snippets are duplicated, or another edit changes the file between `read` and `edit`. This package adds a lightweight optimistic-concurrency check to file edits:

1. `read` returns `LINE#HASH|content` anchors.
2. The model sends target `LINE#HASH` positions back to `edit`.
3. `edit` re-reads the file and verifies every position still matches current content.
4. Any mismatch aborts the whole edit, forcing a fresh read instead of risking the wrong write.

## Install

```bash
pi install npm:pi-hash-anchored-edit
```

Or install from GitHub:

```bash
pi install git:github.com/Fadouse/pi-hash-anchored-edit
```

The extension intentionally registers tools named `read` and `edit`. Pi gives extension tools priority over built-ins with the same name, so normal model calls automatically use these safer implementations.

## Read output

`read` returns every editable text line as:

```text
0001#a1b2|const value = 1;
```

- `0001` is the real 1-based line number, padded to at least 4 digits.
- `a1b2` is `sha256(lineContent).slice(0, 4)`.
- The hash is computed without the newline character.

The raw tool result keeps anchors for the model. The Pi TUI hides anchor noise in collapsed previews and supports Ctrl+O expansion, matching the default Pi read experience.

## Edit schema

```json
{
  "path": "src/file.ts",
  "edits": [
    {
      "pos": "0001#a1b2",
      "op": "patch",
      "old": "1",
      "new": "2"
    }
  ]
}
```

Each edit position is resolved against the current file content before any write happens.

## Edit operations

- `patch` — replace `old` with `new` inside the anchored line. `old` must occur exactly once and both strings must be single-line. Best for small token-efficient changes.
- `replace` — replace the anchored line with `new`. `new` may contain multiple lines.
- `delete` — delete the anchored line.
- `before` — insert `new` before the anchored line.
- `after` — insert `new` after the anchored line.

Example small patch:

```json
{
  "path": "example.txt",
  "edits": [
    { "pos": "0001#dccb", "op": "patch", "old": "I", "new": "he" }
  ]
}
```

Turns:

```text
test I like you
```

into:

```text
test he like you
```

without sending the whole replacement line.

## TUI behavior

- `read` shows a 10-line preview by default and Ctrl+O expands the full result.
- raw `read` output is capped at 400 lines or 32 KiB by default; use `offset`/`limit` to continue.
- `read` mirrors Pi's `:start-end` range display when `offset`/`limit` are used.
- successful `edit` shows only a colored diff in a green edit block.
- failed `edit` shows the error message inside a red edit block.
- raw successful `edit` results include only a small changed-anchor block, or ask the model to `read` again if that block would be too large.

## Safety rules

- Every edit must include `pos` in `LINE#HASH` format.
- Missing or stale positions abort the whole edit.
- Multiple edits for the same position are rejected.
- `patch.old` must occur exactly once on the anchored line.
- Edits are validated against the original file, then applied bottom-up.
- Existing line endings and final newline style are preserved.
- Binary/image files are not inlined.

## Command

```text
/hash-edit-status
```

Shows whether the extension is loaded and which hash length is active.

## Development

```bash
npm install
npm test
```

Project layout:

- `index.ts` registers the extension.
- `src/read.ts` implements the anchored `read` tool.
- `src/edit.ts` implements hash-validated edits.
- `src/shared.ts` contains hashing, line handling, UTF-8 text detection, and TUI helpers.
- `prompts/` stores tool prompt guidelines.
- `test/` stores Node test cases.

## License

MIT
