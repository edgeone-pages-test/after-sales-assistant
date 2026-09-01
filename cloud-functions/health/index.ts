import type { CloudFunctionContext } from '@edgeone/types';
/**
 * Health check — reports AI Gateway configuration status to the frontend.
 *
 * Note: storage (`context.agent.store`) is injected automatically by EdgeOne
 * Makers on every agent/cloud-function entry, so the frontend no longer needs
 * to warn users about Blob credentials.
 */
export async function onRequest(context: CloudFunctionContext) {
  const env = context.env ?? {};
  const hasAiGateway = !!(env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL);

  const missing: string[] = [];
  if (!env.AI_GATEWAY_API_KEY) missing.push("AI_GATEWAY_API_KEY");
  if (!env.AI_GATEWAY_BASE_URL) missing.push("AI_GATEWAY_BASE_URL");

  return new Response(JSON.stringify({
    ok: hasAiGateway,
    hasAiGateway,
    missing,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
