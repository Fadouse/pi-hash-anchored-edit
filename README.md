# Hash-Anchored Edit for Pi

Line-hash anchored replacement for Pi's built-in `read` and `edit` tools.

This extension intentionally registers tools named `read` and `edit`. Pi gives extension tools priority over built-ins with the same name, so normal model calls are routed through these safer implementations.

## Why

Plain line numbers go stale. Exact text edits can match the wrong duplicated block or fail after unrelated changes. Hash anchors bind each editable line to the exact content the model saw.

`read` returns every text line as:

```text
000001#a1b2c3 | const value = 1;
```

- `000001` is the real 1-based line number.
- `a1b2c3` is `sha256(lineContent).slice(0, 6)`.
- The hash is computed without the newline character.

`edit` requires the line number and hash for every mutation. Before writing, it re-reads the file and verifies every anchor against current content. If anything changed, the edit is rejected and the model must read again.

## Edit schema

```json
{
  "path": "src/file.ts",
  "edits": [
    {
      "line": 12,
      "hash": "a1b2c3",
      "mode": "replace",
      "newText": "const value = 2;"
    }
  ]
}
```

### Modes

- `replace` — replace the anchored line with `newText`.
- `delete` — delete the anchored line.
- `insert_before` — insert `newText` before the anchored line.
- `insert_after` — insert `newText` after the anchored line.

`newText` may contain multiple lines for replace/insert operations.

## Safety rules

- Every edit must include `line` and `hash`.
- Hash mismatches abort the whole edit.
- Multiple edits for the same line are rejected.
- Edits are validated against the original file, then applied bottom-up.
- Existing line endings are preserved.
- Binary/image files are not inlined; use shell tools or the original Pi read if needed.

## Commands

```text
/hash-edit-status
```

Shows whether the extension is loaded and which hash length is active.

## Notes

This extension is deliberately small and deterministic. It does not call an LLM, does not format code, and does not auto-fix conflicts. On success, `edit` returns an `Updated anchors:` section for the lines it changed or inserted. Use those anchors for follow-up edits without re-reading the whole file. On conflict, read again and retry with fresh anchors.
