import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerEditTool } from "./src/edit.ts";
import { registerReadTool } from "./src/read.ts";
import { HASH_LEN } from "./src/shared.ts";

export default function hashAnchoredEdit(pi: ExtensionAPI) {
  registerReadTool(pi);
  registerEditTool(pi);

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
