Use read before edit. Every editable line is returned as LINE#HASH|content.
When editing, copy the target LINE#HASH into edit.edits[].pos.
If edit reports a hash mismatch, read the file again and retry with fresh anchors.
