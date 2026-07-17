import { requireUserSession } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { storageErrorResponse } from "@/lib/route-errors";
import { deleteMarketAgent, getMarketAgent, updateMarketAgent } from "@/lib/storage";
import { entityIdSchema, marketAgentSchema } from "@/lib/validation";
import type { MarketAgentDoc } from "@/lib/types";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

async function marketAgentId(context: RouteContext): Promise<string | null> {
  const { id } = await context.params;
  return entityIdSchema.safeParse(id).success ? id : null;
}

function responseAgent(agent: MarketAgentDoc) {
  return {
    id: agent._id,
    name: agent.name,
    avatarUrl: agent.avatarUrl ? appUrl(`/api/market/agents/${agent._id}/avatar`) : null,
    avatarVersion: agent.avatarVersion ?? null,
    systemPrompt: agent.systemPrompt,
    temperature: agent.temperature,
    topP: agent.topP,
    maxTokens: agent.maxTokens ?? null,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    version: agent.version,
  };
}

export async function GET(request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) return jsonError("Unauthorized.", 401);
  const id = await marketAgentId(context);
  if (!id) return jsonError("Invalid market agent ID.", 400);

  try {
    const agent = await getMarketAgent(id);
    if (!agent) return jsonError("Market Agent not found.", 404);
    return jsonOk({ agent: responseAgent(agent), isOwner: agent.ownerUserId === session.sub });
  } catch (error) {
    return storageErrorResponse(error, "Unable to load the market agent.");
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) return jsonError("Unauthorized.", 401);
  const id = await marketAgentId(context);
  if (!id) return jsonError("Invalid market agent ID.", 400);
  const parsed = marketAgentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid market agent payload.", 400);

  try {
    const agent = await updateMarketAgent(session.sub, id, parsed.data);
    return jsonOk({ agent: responseAgent(agent) });
  } catch (error) {
    return storageErrorResponse(error, "Unable to update the market agent.");
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) return jsonError("Unauthorized.", 401);
  const id = await marketAgentId(context);
  if (!id) return jsonError("Invalid market agent ID.", 400);

  try {
    await deleteMarketAgent(session.sub, id);
    return jsonOk({ success: true });
  } catch (error) {
    return storageErrorResponse(error, "Unable to remove the market agent.");
  }
}
