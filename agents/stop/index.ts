import type { AgentContext } from '@edgeone/types';
/**
 * Stop active run — abort the running generation for this conversation.
 *
 * The runtime requires `makers-conversation-id` (or an inherited conversation
 * context) before invoking an agent endpoint. The frontend sends the same ID in
 * the body as well so the handler remains explicit about which run to stop.
 */
export async function onRequest(context: AgentContext) {
  // Body wins when present; runtime-injected context.conversation_id acts as
  // a fallback after the runtime resolves the required conversation header.
  const body = ((context.request?.body ?? {}) as Record<string, any>) as Record<string, unknown>;
  const conversationId =
    (body.conversation_id as string | undefined) ??
    (body.conversationId as string | undefined) ??
    context.conversation_id;

  if (!conversationId) {
    return new Response(JSON.stringify({ error: "Missing conversation_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=UTF-8" },
    });
  }

  const result = context.utils.abortActiveRun(conversationId);

  return new Response(JSON.stringify({
    status: result.aborted ? "stopped" : "no_active_run",
    conversationId,
    ...result,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
}
