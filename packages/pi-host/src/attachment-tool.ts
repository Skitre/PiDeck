import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AttachmentStore, AttachmentReadResult } from "./attachment-store.js";

export const READ_ATTACHMENT_TOOL_NAME = "read_attachment";

export function createReadAttachmentTool(store: AttachmentStore): ToolDefinition {
  return defineTool({
    name: READ_ATTACHMENT_TOOL_NAME,
    label: "Read attachment",
    description:
      "Read a bounded range from a document or pasted-text attachment in this conversation. PDF units are pages; DOCX and TXT units are logical chunks. Use the attachment IDs shown in the user message.",
    promptSnippet: "Read attached PDF/DOCX/TXT content by page or chunk",
    promptGuidelines: [
      "Use read_attachment for document attachments instead of guessing their contents.",
      "Read only the page or chunk ranges needed and continue with the returned hasMore flag.",
    ],
    parameters: Type.Object(
      {
        attachmentId: Type.String({
          format: "uuid",
          description: "Attachment ID from the user message",
        }),
        start: Type.Optional(Type.Integer({ minimum: 1, description: "1-based page or chunk" })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 10, description: "Units to read" }),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) throw new Error("No active session is available for attachment access");
      const result: AttachmentReadResult = await store.read({
        attachmentId: params.attachmentId,
        sessionId,
        ...(params.start !== undefined ? { start: params.start } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
      signal?.throwIfAborted();
      const range = `${result.unit} ${result.start}-${result.end} of ${result.total}`;
      const continuation = result.hasMore
        ? `\n\nMore content is available. Continue at start=${result.end + 1}.`
        : "";
      const truncated = result.truncated
        ? "\n\nThis unit exceeded the output limit and was truncated."
        : "";
      return {
        content: [
          {
            type: "text",
            text: `${result.name} (${range})\n\n${result.content}${continuation}${truncated}`,
          },
        ],
        details: result,
      };
    },
  });
}
