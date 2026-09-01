import type { AgentContext } from '@edgeone/types';
import type { BaseStore } from '@langchain/langgraph';
/**
 * Seed Demo Agent — imports demo documents into the knowledge base.
 *
 * Migrated from cloud-functions/seed-demo to bypass the 30s cloud-function
 * timeout (importing 11 docs needs 11 LLM summary calls back-to-back).
 *
 * Locale-aware: imports DEMO_DOCS_EN/ORDERS_EN when body.locale === "en".
 */
import { createLogger, createModel, createSSEResponse, sseEvent } from "../_shared";
import { getDemoDocs, getDemoOrders } from "../_data/demo-docs";
import { saveDoc } from "../../lib/doc-store";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { t, getLocale, type Locale } from "../_i18n";

const logger = createLogger("seed-demo");

type AgentEnv = Record<string, string | undefined>;

async function generateSummary(title: string, content: string, locale: Locale, env: AgentEnv): Promise<{ summary: string; keywords: string[] }> {
  const model = createModel(env);
  const sysPrompt = locale === "en"
    ? `Generate a short summary (1-2 sentences) and 5 keywords for the document. Return JSON: {"summary":"...","keywords":["k1","k2","k3","k4","k5"]}`
    : `为以下文档生成简短摘要（1-2句）和5个关键词。返回JSON：{"summary":"...","keywords":["k1","k2","k3","k4","k5"]}`;
  const userPrompt = locale === "en"
    ? `Title: ${title}\n\nContent: ${content.slice(0, 1500)}`
    : `标题：${title}\n\n内容：${content.slice(0, 1500)}`;
  const response = await model.invoke([
    new SystemMessage(sysPrompt),
    new HumanMessage(userPrompt),
  ]);
  const text = typeof response.content === "string" ? response.content : "";
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {}
  return { summary: content.slice(0, 100), keywords: [title] };
}

async function* streamSeedDemo(store: any, locale: Locale, env: AgentEnv): AsyncGenerator<string> {
  const kv = store.langgraphStore as BaseStore;
  const DEMO_DOCS = getDemoDocs(locale);
  const DEMO_ORDERS = getDemoOrders(locale);

  const total = DEMO_DOCS.length + DEMO_ORDERS.length;
  yield sseEvent({
    type: "progress",
    message: t(locale, "seed.start", { docs: DEMO_DOCS.length, orders: DEMO_ORDERS.length }),
    total,
  });

  let imported = 0;
  let failed = 0;

  // ─── Import knowledge base documents ───
  for (const doc of DEMO_DOCS) {
    const docId = `demo-${doc.category}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const stepNum = imported + failed + 1;

    yield sseEvent({
      type: "progress",
      message: t(locale, "seed.indexing", { i: stepNum, n: total, title: doc.title }),
      current: stepNum,
      total,
    });

    try {
      const { summary, keywords } = await generateSummary(doc.title, doc.content, locale, env);
      await saveDoc(store, doc.category, docId, doc.title, doc.content, summary, keywords);
      imported++;
      yield sseEvent({ type: "doc_imported", docId, title: doc.title, category: doc.category, summary });
    } catch (e) {
      failed++;
      logger.error(`Failed to import ${doc.title}:`, (e as Error).message);
      yield sseEvent({ type: "doc_error", title: doc.title, error: (e as Error).message });
    }
  }

  // ─── Import demo orders (with manifest maintenance) ───
  const ORDERS_NS = ["aftersales", "orders"];
  const ORDERS_MANIFEST_NS = ["aftersales", "orders_manifest"];
  const importedOrderIds: string[] = [];

  let existingIds: string[] = [];
  try {
    const existingIdx = await kv.get(ORDERS_MANIFEST_NS, "all").catch(() => null);
    existingIds = existingIdx?.value?.ids || [];
  } catch {}

  for (const order of DEMO_ORDERS) {
    const stepNum = imported + failed + 1;

    yield sseEvent({
      type: "progress",
      message: t(locale, "seed.importingOrder", { i: stepNum, n: total, orderId: order.orderId }),
      current: stepNum,
      total,
    });

    try {
      await kv.put(ORDERS_NS, order.orderId, { ...order });
      importedOrderIds.push(order.orderId);

      const allIds = [...new Set([...existingIds, ...importedOrderIds])];
      try {
        await kv.put(ORDERS_MANIFEST_NS, "all", { ids: allIds });
      } catch (e) {
        logger.error("Failed to update orders manifest:", (e as Error).message);
      }

      imported++;
      yield sseEvent({ type: "order_imported", title: order.orderId, category: "order" });
    } catch (e) {
      failed++;
      logger.error(`Failed to import order ${order.orderId}:`, (e as Error).message);
    }
  }

  logger.log(`[${locale}] Orders imported: ${importedOrderIds.length}`);

  if (imported === 0 && failed > 0) {
    yield sseEvent({ type: "error_message", content: t(locale, "seed.failure", { failed }) });
  } else {
    const message = failed > 0
      ? t(locale, "seed.successWithFailures", { imported, failed })
      : t(locale, "seed.successOnly", { imported });
    yield sseEvent({ type: "progress", message });
    yield sseEvent({ type: "complete", total: imported, failed, skipped: false });
  }
  yield "data: [DONE]\n\n";
}

export async function onRequest(context: AgentContext) {
  const env = context.env ?? {};
  if (!env.AI_GATEWAY_API_KEY || !env.AI_GATEWAY_BASE_URL) {
    return new Response(JSON.stringify({ error: "AI Gateway not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const store = context.store ?? null;
  if (!store) {
    return new Response(JSON.stringify({
      error: "STORE_NOT_CONFIGURED",
      message: "Storage is not available. Deploy to EdgeOne Makers for automatic configuration.",
    }), { status: 503, headers: { "Content-Type": "application/json" } });
  }

  const body = (context.request?.body ?? {}) as Record<string, any>;
  const locale = getLocale(body);
  logger.log(`Seeding demo documents (locale=${locale})...`);
  const signal = context.request?.signal as AbortSignal | undefined;
  const generator = streamSeedDemo(store, locale, env);
  return createSSEResponse(generator, signal);
}
