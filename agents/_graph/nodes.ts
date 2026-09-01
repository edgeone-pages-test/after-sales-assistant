import type { AgentContext } from '@edgeone/types';
import type { BaseStore } from '@langchain/langgraph';
/**
 * Graph nodes — each node is a function (state) => partial state update.
 * All user-facing strings are routed through agents/_i18n.ts (state.locale).
 *
 * `context` (carrying context.store) is closed over by the graph builder so that
 * every request binds its own store — no module-level mutable state, safe under
 * concurrency.
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createModel, createLogger } from "../_shared";
import type { AfterSalesStateType } from "./state";

/** AI Gateway env, threaded from context.env through the graph builder. */
type AgentEnv = Record<string, string | undefined>;
import { getAllSummaries, getDocContent, saveDoc } from "../../lib/doc-store";
import type { Order } from "../_shared";
import { t, statusLabel, languageDirective, type Locale } from "../_i18n";

const logger = createLogger("nodes");

type StreamRuntime = {
  signal?: AbortSignal;
  writer?: (event: Record<string, unknown>) => void;
};

function chunkText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
    return "";
  }).join("");
}

async function streamAnswer(
  model: ReturnType<typeof createModel>,
  messages: Parameters<ReturnType<typeof createModel>["invoke"]>[0],
  runtime: StreamRuntime | undefined,
  node: string,
): Promise<string> {
  let answer = "";
  const stream = await (model as any).stream(messages, runtime?.signal ? { signal: runtime.signal } : undefined);
  for await (const chunk of stream) {
    if (runtime?.signal?.aborted) break;
    const delta = chunkText(chunk?.content);
    if (!delta) continue;
    answer += delta;
    runtime?.writer?.({ type: "ai_response_delta", node, delta });
  }
  return answer;
}

// ─── Store Order Helpers ───

const ORDERS_NAMESPACE = ["aftersales", "orders"];
const ORDERS_MANIFEST_NAMESPACE = ["aftersales", "orders_manifest"];

async function getAllOrders(context: AgentContext): Promise<Order[]> {
  try {
    const kv = context?.store?.langgraphStore as BaseStore | undefined;
    if (!kv) return [];
    const idx = await kv.get(ORDERS_MANIFEST_NAMESPACE, "all").catch(() => null);
    const ids: string[] = idx?.value?.ids || [];
    if (ids.length === 0) return [];
    const orders = await Promise.all(
      ids.map(async (id: string) => {
        const item = await kv.get(ORDERS_NAMESPACE, id).catch(() => null);
        return (item?.value as Order) || null;
      })
    );
    return orders.filter(Boolean) as Order[];
  } catch {}
  return [];
}

async function getOrderById(context: AgentContext, orderId: string): Promise<Order | null> {
  try {
    const kv = context?.store?.langgraphStore as BaseStore | undefined;
    if (!kv) return null;
    const item = await kv.get(ORDERS_NAMESPACE, orderId);
    return (item?.value as Order) ?? null;
  } catch {}
  return null;
}

// ─── Blob Order Helpers ───

const ORDER_FILENAME_RE = /^ORD-\d{8}-\d{3,}/i;

function filterOrderSummaries(summaries: Awaited<ReturnType<typeof getAllSummaries>>) {
  return summaries.filter(s => ORDER_FILENAME_RE.test(s.filename));
}

async function lookupBlobOrderDoc(context: AgentContext, orderId: string): Promise<{
  content: string;
  docId: string;
  summary: string;
  keywords: string[];
  filename: string;
} | null> {
  try {
    const summaries = await getAllSummaries(context.store, "order_doc");
    const needle = orderId.toUpperCase();
    const matchedDoc = summaries.find(
      s =>
        s.filename.toUpperCase() === needle ||
        s.keywords.some(k => k.toUpperCase() === needle)
    );
    if (!matchedDoc) return null;
    const content = await getDocContent(context.store, "order_doc", matchedDoc.docId);
    if (!content) return null;
    return {
      content,
      docId: matchedDoc.docId,
      summary: matchedDoc.summary,
      keywords: matchedDoc.keywords,
      filename: matchedDoc.filename,
    };
  } catch {
    return null;
  }
}

/** Detect order status from free-text content (bilingual keywords). */
function detectStatusFromText(text: string): string {
  const t = text.toLowerCase();
  if (text.includes("换货申请") || t.includes("exchange_requested") || t.includes("exchange requested")) return "exchange_requested";
  if (text.includes("退款申请") || text.includes("退款中") || t.includes("refund_requested") || t.includes("refund requested")) return "refund_requested";
  if (text.includes("已签收") || text.includes("已收货") || text.includes("签收") || t.includes("delivered")) return "delivered";
  if (text.includes("运输中") || text.includes("已发货") || text.includes("在途") || t.includes("shipped") || t.includes("in transit")) return "shipped";
  if (text.includes("待发货") || text.includes("未发货") || t.includes("pending")) return "pending";
  return "unknown";
}

// ─── Intent Recognition ───

export async function intentRecognition(state: AfterSalesStateType, env: AgentEnv, runtime?: StreamRuntime) {
  const ORDER_ID_RE = /ORD-\d{8}-\d{3}/i;
  if (
    state.waitingForUser &&
    (state.intent === "exchange" || state.intent === "refund") &&
    ORDER_ID_RE.test(state.userInput.trim())
  ) {
    const orderId = state.userInput.trim().match(ORDER_ID_RE)![0].toUpperCase();
    logger.log(`Context carry-forward: intent=${state.intent}, orderId=${orderId}`);
    return { intent: state.intent, orderId, waitingForUser: false };
  }
  const model = createModel(env);
  // Intent prompt stays in Chinese — returns fixed JSON schema, LLM understands EN input fine
  const response = await model.invoke([
    new SystemMessage(`你是一个售后客服意图分类器。根据用户消息（无论中文还是英文）判断意图，输出 JSON：
{"intent": "faq"|"lookup_order"|"refund"|"exchange"|"general", "orderId": "如有提到订单号则提取，否则null", "reason": "简要说明"}

意图说明：
- faq: 用户询问政策/规则/流程/产品信息（退货政策、运费、保修、产品使用说明等）——覆盖知识库中所有文档类别（faq/policy/product/order_doc）
- lookup_order: 用户要查订单状态/物流
- refund: 用户要退货或退款
- exchange: 用户要换货
- general: 闲聊/打招呼/其他

如果用户同时提到订单号和退货，优先判断为 refund/exchange。`),
    new HumanMessage(state.userInput),
  ], runtime?.signal ? { signal: runtime.signal } : undefined);

  const text = typeof response.content === "string" ? response.content : "";
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      logger.log(`Intent: ${parsed.intent}, orderId: ${parsed.orderId}`);
      return {
        intent: parsed.intent || "general",
        orderId: parsed.orderId || state.orderId || null,
      };
    }
  } catch {}
  return { intent: "general" as const, orderId: state.orderId || null };
}

// ─── FAQ Search (Knowledge Base) ───

export async function faqSearch(state: AfterSalesStateType, env: AgentEnv, context: AgentContext, runtime?: StreamRuntime) {
  const locale = (state.locale || "zh") as Locale;
  const summaries = await getAllSummaries(context.store);
  logger.log(`Knowledge base has ${summaries.length} documents`);

  if (summaries.length === 0) {
    return {
      aiResponse: t(locale, "ai.kbEmpty"),
      faqResults: [],
      cardEvent: null,
    };
  }

  const model = createModel(env);
  const summaryList = summaries.map((s, i) => `[${i}] 【${s.category}】${s.filename}: ${s.summary} (keywords: ${s.keywords.join(", ")})`).join("\n");

  // Routing prompt — output is fixed JSON schema, language doesn't matter
  const routeResponse = await model.invoke([
    new SystemMessage(`你是一个文档路由助手。根据用户问题（中英文均可），从以下文档列表中选择 1-3 个最相关的文档。
返回严格 JSON 格式：{"indices": [0, 2]}

如果没有相关文档，返回：{"indices": []}

文档列表：
${summaryList}`),
    new HumanMessage(state.userInput),
  ], runtime?.signal ? { signal: runtime.signal } : undefined);

  const routeText = typeof routeResponse.content === "string" ? routeResponse.content : "";
  let selectedIndices: number[] = [];

  try {
    const match = routeText.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.indices)) {
        selectedIndices = parsed.indices.filter((i: number) => i >= 0 && i < summaries.length);
      }
    }
  } catch {}

  if (selectedIndices.length === 0) {
    return {
      aiResponse: t(locale, "ai.faqNotFound"),
      faqResults: [],
      cardEvent: null,
    };
  }

  const selectedDocs = selectedIndices.map(i => summaries[i]);
  const contents = await Promise.all(
    selectedDocs.map(async (doc) => {
      const content = await getDocContent(context.store, doc.category, doc.docId);
      return { ...doc, content: content || doc.summary };
    })
  );

  logger.log(`Selected ${contents.length} docs for answer generation (locale=${locale})`);

  const contextText = contents.map(d => `【${d.category}/${d.filename}】\n${d.content}`).join("\n\n");

  // Answer generation — language directive forces output in user locale
  const answer = await streamAnswer(model, [
    new SystemMessage(`你是售后客服助手。根据以下知识库文档回答用户问题。
要求：
- 简洁友好，不要照搬原文
- 如果涉及具体操作，给出清晰步骤
- 如果用户需要进一步帮助，引导他提供订单号
- 注明信息来源的文档类别

知识库文档：
${contextText}${languageDirective(locale)}`),
    new HumanMessage(state.userInput),
  ], runtime, "faq_search");
  return {
    aiResponse: answer,
    faqResults: contents.map(d => ({ id: d.docId, title: d.filename, content: d.content })),
    cardEvent: {
      type: "faq_sources",
      data: { sources: selectedDocs.map(d => ({ id: d.docId, title: d.filename, category: d.category })) },
    },
  };
}

// ─── Lookup Order ───

export async function lookupOrder(state: AfterSalesStateType, context: AgentContext) {
  const locale = (state.locale || "zh") as Locale;
  const sep = locale === "en" ? ", " : "、";
  const orderId = state.orderId;

  if (!orderId) {
    const [storeOrders, blobSummaries] = await Promise.all([
      getAllOrders(context),
      getAllSummaries(context.store, "order_doc").then(filterOrderSummaries),
    ]);

    const storeLines = storeOrders.map(o => {
      const itemNames = o.items.map(i => i.name).join(sep);
      return `- **${o.orderId}**: ${itemNames} (${statusLabel(locale, o.status)}, ¥${o.totalAmount})`;
    });

    const blobLines = blobSummaries.map(s => {
      const status = detectStatusFromText(s.summary + " " + s.keywords.join(" "));
      return `- **${s.filename}**: ${s.summary.slice(0, 40)} (${statusLabel(locale, status)})`;
    });

    const allLines = [...storeLines, ...blobLines].join("\n");

    if (!allLines.trim()) {
      return {
        aiResponse: t(locale, "ai.noOrders"),
        waitingForUser: false,
        cardEvent: null,
      };
    }

    return {
      aiResponse: t(locale, "ai.orderListPrompt", { lines: allLines }),
      waitingForUser: true,
      cardEvent: null,
    };
  }

  let order = (state.currentOrder?.orderId === orderId) ? state.currentOrder : null;
  if (!order) {
    order = await getOrderById(context, orderId);
  }

  if (!order) {
    const blobDoc = await lookupBlobOrderDoc(context, orderId);
    if (blobDoc) {
      return {
        aiResponse: t(locale, "ai.orderFoundFromBlob", { orderId, content: blobDoc.content }),
        cardEvent: null,
      };
    }

    return {
      aiResponse: t(locale, "ai.orderNotFound", { orderId }),
      currentOrder: null,
      cardEvent: null,
    };
  }

  const tracking = order.trackingNumber
    ? t(locale, "ai.trackingLine", { carrier: order.carrier || "", trackingNumber: order.trackingNumber })
    : "";
  return {
    currentOrder: order,
    aiResponse: t(locale, "ai.orderFound", {
      orderId: order.orderId,
      statusLabel: statusLabel(locale, order.status),
      tracking,
    }),
    cardEvent: { type: "order_detail", data: { order } },
  };
}

// ─── Request Refund ───

export async function requestRefund(state: AfterSalesStateType, context: AgentContext) {
  const locale = (state.locale || "zh") as Locale;
  const sep = locale === "en" ? ", " : "、";
  const ineligibleNote = (label: string) => locale === "en" ? ` *(${label}, not eligible for refund)*` : ` *(${label}，暂不可退款)*`;

  if (!state.currentOrder && !state.orderId) {
    const [storeOrders, blobSummaries] = await Promise.all([
      getAllOrders(context),
      getAllSummaries(context.store, "order_doc").then(filterOrderSummaries),
    ]);

    const storeLines = storeOrders.map(o => {
      const itemNames = o.items.map(i => i.name).join(sep);
      const eligible = o.status === "delivered" || o.status === "shipped";
      const note = eligible ? "" : ineligibleNote(statusLabel(locale, o.status));
      return `- **${o.orderId}**: ${itemNames} (¥${o.totalAmount})${note}`;
    });

    const blobLines = blobSummaries.map(s => {
      const status = detectStatusFromText(s.summary + " " + s.keywords.join(" "));
      const eligible = status === "delivered" || status === "shipped";
      const note = eligible ? "" : ineligibleNote(statusLabel(locale, status));
      return `- **${s.filename}**: ${s.summary.slice(0, 30)}...${note}`;
    });

    const allLines = [...storeLines, ...blobLines].join("\n");
    if (!allLines.trim()) {
      return { aiResponse: t(locale, "ai.refundNoOrders"), waitingForUser: false, cardEvent: null };
    }
    return {
      aiResponse: t(locale, "ai.refundOrderListPrompt", { lines: allLines }),
      waitingForUser: true,
      cardEvent: null,
    };
  }

  let order = state.currentOrder;
  if (!order && state.orderId) {
    order = await getOrderById(context, state.orderId);
  }

  if (!order) {
    const orderId = state.orderId!;
    const blobDoc = await lookupBlobOrderDoc(context, orderId);
    if (blobDoc) {
      const status = detectStatusFromText(blobDoc.content + " " + blobDoc.keywords.join(" "));

      if (status === "refund_requested" || status === "refund_completed") {
        return {
          aiResponse: t(locale, "ai.refundDuplicate", { orderId, content: blobDoc.content }),
          cardEvent: null,
        };
      }

      if (status !== "delivered" && status !== "shipped") {
        return {
          aiResponse: t(locale, "ai.refundIneligibleWithDetail", {
            orderId,
            statusLabel: statusLabel(locale, status),
            content: blobDoc.content,
          }),
          cardEvent: null,
        };
      }

      const refundMarker = locale === "en"
        ? `\n\n---\nRefund request submitted (${new Date().toISOString().split("T")[0]})`
        : `\n\n---\n退款申请已提交（${new Date().toISOString().split("T")[0]}）`;
      const updatedContent = `${blobDoc.content}${refundMarker}`;
      const refundKeyword = locale === "en" ? "refund_requested" : "退款申请中";
      try {
        await saveDoc(
          context.store,
          "order_doc",
          blobDoc.docId,
          blobDoc.filename,
          updatedContent,
          blobDoc.summary,
          [
            ...blobDoc.keywords.filter(k => !k.includes("退款") && !k.includes("换货") && !k.includes("refund") && !k.includes("exchange")),
            refundKeyword,
          ]
        );
      } catch {}

      return {
        aiResponse: t(locale, "ai.refundSubmittedSimple", { orderId }),
        cardEvent: {
          type: "refund_progress",
          data: {
            order: {
              orderId,
              status: "refund_requested",
              refundReason: locale === "en" ? "Customer requested refund" : "用户申请退货退款",
              refundAmount: 0,
              totalAmount: 0,
              items: [{ name: locale === "en" ? "Item (see order document)" : "商品（详见订单文档）" }],
              updatedAt: new Date().toISOString(),
            },
          },
        },
      };
    }

    return { aiResponse: t(locale, "ai.orderNotFoundShort", { orderId: state.orderId || "" }), cardEvent: null };
  }

  if (order.status === "refund_requested" || order.status === "refund_approved" || order.status === "refund_completed") {
    return {
      aiResponse: t(locale, "ai.refundDuplicateShort", {
        orderId: order.orderId,
        statusLabel: statusLabel(locale, order.status),
      }),
      currentOrder: order,
      cardEvent: { type: "refund_progress", data: { order } },
    };
  }

  if (order.status !== "delivered" && order.status !== "shipped") {
    return {
      aiResponse: t(locale, "ai.refundIneligible", {
        orderId: order.orderId,
        statusLabel: statusLabel(locale, order.status),
      }),
      cardEvent: null,
    };
  }

  const updatedOrder = {
    ...order,
    status: "refund_requested" as const,
    refundReason: state.refundReason || (locale === "en" ? "Customer requested refund" : "用户申请退货退款"),
    refundAmount: order.totalAmount,
    updatedAt: new Date().toISOString(),
  };

  return {
    currentOrder: updatedOrder,
    aiResponse: t(locale, "ai.refundSubmitted", {
      orderId: updatedOrder.orderId,
      amount: updatedOrder.refundAmount,
    }),
    cardEvent: { type: "refund_progress", data: { order: updatedOrder } },
  };
}

// ─── Request Exchange ───

export async function requestExchange(state: AfterSalesStateType, context: AgentContext) {
  const locale = (state.locale || "zh") as Locale;
  const sep = locale === "en" ? ", " : "、";
  const ineligibleNote = (label: string) => locale === "en" ? ` *(${label}, not eligible for exchange)*` : ` *(${label}，暂不可换货)*`;

  if (!state.currentOrder && !state.orderId) {
    const [storeOrders, blobSummaries] = await Promise.all([
      getAllOrders(context),
      getAllSummaries(context.store, "order_doc").then(filterOrderSummaries),
    ]);

    const storeLines = storeOrders.map(o => {
      const itemNames = o.items.map(i => i.name).join(sep);
      const eligible = o.status === "delivered";
      const note = eligible ? "" : ineligibleNote(statusLabel(locale, o.status));
      return `- **${o.orderId}**: ${itemNames} (¥${o.totalAmount})${note}`;
    });

    const blobLines = blobSummaries.map(s => {
      const status = detectStatusFromText(s.summary + " " + s.keywords.join(" "));
      const eligible = status === "delivered";
      const note = eligible ? "" : ineligibleNote(statusLabel(locale, status));
      return `- **${s.filename}**: ${s.summary.slice(0, 30)}...${note}`;
    });

    const allLines = [...storeLines, ...blobLines].join("\n");
    if (!allLines.trim()) {
      return { aiResponse: t(locale, "ai.exchangeNoOrders"), waitingForUser: false, cardEvent: null };
    }
    return {
      aiResponse: t(locale, "ai.exchangeOrderListPrompt", { lines: allLines }),
      waitingForUser: true,
      cardEvent: null,
    };
  }

  let order = state.currentOrder;
  if (!order && state.orderId) {
    order = await getOrderById(context, state.orderId);
  }

  if (!order) {
    const orderId = state.orderId!;
    const blobDoc = await lookupBlobOrderDoc(context, orderId);
    if (blobDoc) {
      const status = detectStatusFromText(blobDoc.content + " " + blobDoc.keywords.join(" "));

      if (status === "exchange_requested") {
        return {
          aiResponse: t(locale, "ai.exchangeDuplicate", { orderId, content: blobDoc.content }),
          cardEvent: null,
        };
      }

      if (status !== "delivered") {
        return {
          aiResponse: t(locale, "ai.exchangeIneligible", {
            orderId,
            statusLabel: statusLabel(locale, status),
            content: blobDoc.content,
          }),
          cardEvent: null,
        };
      }

      const exchangeMarker = locale === "en"
        ? `\n\n---\nExchange request submitted (${new Date().toISOString().split("T")[0]})`
        : `\n\n---\n换货申请已提交（${new Date().toISOString().split("T")[0]}）`;
      const updatedContent = `${blobDoc.content}${exchangeMarker}`;
      const exchangeKeyword = locale === "en" ? "exchange_requested" : "换货申请中";
      try {
        await saveDoc(
          context.store,
          "order_doc",
          blobDoc.docId,
          blobDoc.filename,
          updatedContent,
          blobDoc.summary,
          [
            ...blobDoc.keywords.filter(k => !k.includes("退款") && !k.includes("换货") && !k.includes("refund") && !k.includes("exchange")),
            exchangeKeyword,
          ]
        );
      } catch {}

      return {
        aiResponse: t(locale, "ai.exchangeSubmittedNoItems", { orderId }),
        cardEvent: {
          type: "exchange_confirm",
          data: {
            order: {
              orderId,
              status: "exchange_requested",
              items: [{ name: locale === "en" ? "Item (see order document)" : "商品（详见订单文档）", specs: "-" }],
              exchangeReason: state.exchangeTarget || (locale === "en" ? "Customer requested exchange" : "用户申请换货"),
              updatedAt: new Date().toISOString(),
            },
          },
        },
      };
    }

    return { aiResponse: t(locale, "ai.orderNotFoundShort", { orderId: state.orderId || "" }), cardEvent: null };
  }

  if (order.status !== "delivered") {
    return {
      aiResponse: t(locale, "ai.exchangeIneligibleShort", {
        orderId: order.orderId,
        statusLabel: statusLabel(locale, order.status),
      }),
      cardEvent: null,
    };
  }

  const updatedOrder = {
    ...order,
    status: "exchange_requested" as const,
    exchangeReason: state.exchangeTarget || (locale === "en" ? "Customer requested exchange" : "用户申请换货"),
    updatedAt: new Date().toISOString(),
  };

  return {
    currentOrder: updatedOrder,
    aiResponse: t(locale, "ai.exchangeSubmitted", {
      orderId: updatedOrder.orderId,
      items: order.items.map(i => i.name).join(sep),
    }),
    cardEvent: { type: "exchange_confirm", data: { order: updatedOrder } },
  };
}

// ─── General Chat ───

export async function generalChat(state: AfterSalesStateType, env: AgentEnv, runtime?: StreamRuntime) {
  const locale = (state.locale || "zh") as Locale;
  const model = createModel(env);
  const answer = await streamAnswer(model, [
    new SystemMessage(`你是一个友好的售后客服助手。可以帮助用户：
- 查询订单状态（需要订单号）
- 申请退货/退款
- 申请换货
- 回答售后政策问题

如果用户的问题模糊，引导他们提供更多信息。保持简洁友好。${languageDirective(locale)}`),
    new HumanMessage(state.userInput),
  ], runtime, "general_chat");
  return {
    aiResponse: answer,
    cardEvent: null,
  };
}
