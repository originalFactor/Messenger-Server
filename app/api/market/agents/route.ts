import { requireUserSession } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { storageErrorResponse } from "@/lib/route-errors";
import { createMarketAgent, encodeMarketCursor, listMarketAgents } from "@/lib/storage";
import { marketAgentSchema } from "@/lib/validation";
import type { MarketAgentDoc } from "@/lib/types";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

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

export async function GET(request: Request) {
  const session = await requireUserSession();
  if (!session) return jsonError("Unauthorized.", 401);

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query")?.trim().slice(0, 200) ?? "";
  const cursor = searchParams.get("cursor");
  const requestedLimit = Number.parseInt(searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  try {
    const agents = await listMarketAgents(query, limit + 1, cursor);
    const hasMore = agents.length > limit;
    const page = hasMore ? agents.slice(0, limit) : agents;
    const last = page.at(-1);
    const nextCursor = hasMore && last
      ? encodeMarketCursor(last.updatedAt, last._id)
      : null;
    return jsonOk({
      agents: page.map(responseAgent),
      nextCursor,
    });
  } catch (error) {
    return storageErrorResponse(error, "Unable to list market agents.");
  }
}

export async function POST(request: Request) {
  const session = await requireUserSession();
  if (!session) return jsonError("Unauthorized.", 401);

  const parsed = marketAgentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid market agent payload.", 400);

  try {
    const agent = await createMarketAgent(session.sub, parsed.data);
    return jsonOk({ agent: responseAgent(agent) }, 201);
  } catch (error) {
    return storageErrorResponse(error, "Unable to publish the market agent.");
  }
}
