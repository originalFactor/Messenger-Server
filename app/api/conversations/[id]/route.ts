import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { storageErrorResponse } from "@/lib/route-errors";
import { softDeleteConversation, upsertConversation } from "@/lib/storage";
import { conversationSchema, entityIdSchema } from "@/lib/validation";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

async function getConversationId(context: RouteContext): Promise<string | null> {
  const { id } = await context.params;
  return entityIdSchema.safeParse(id).success ? id : null;
}

export async function PUT(request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const conversationId = await getConversationId(context);
  if (!conversationId) {
    return jsonError("Invalid conversation ID.", 400);
  }

  const parsed = conversationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid conversation payload.", 400);
  }
  if (parsed.data.id !== conversationId) {
    return jsonError("The conversation ID must match the request path.", 400);
  }

  try {
    const version = await upsertConversation(session.sub, parsed.data);
    return jsonOk({ id: conversationId, version });
  } catch (error) {
    return storageErrorResponse(error, "Unable to save the conversation.");
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const conversationId = await getConversationId(context);
  if (!conversationId) {
    return jsonError("Invalid conversation ID.", 400);
  }

  try {
    const version = await softDeleteConversation(session.sub, conversationId);
    return jsonOk({ id: conversationId, version });
  } catch (error) {
    return storageErrorResponse(error, "Unable to delete the conversation.");
  }
}
