import type { AgentContext } from '@edgeone/types';
import type { BaseStore } from '@langchain/langgraph';
/**
 * Shared utilities for after-sales assistant agent.
 */
import { ChatOpenAI } from "@langchain/openai";

// ─── Model ───

type AgentEnv = Record<string, string | undefined>;

// Cache models by credential fingerprint (baseURL::apiKey). No module-level
// mutable env state — env is always passed in per request, so concurrent
// requests never clobber each other.
const _modelCache = new Map<string, ChatOpenAI>();

export function createModel(env: AgentEnv): ChatOpenAI {
  const apiKey = env.AI_GATEWAY_API_KEY;
  const baseURL = env.AI_GATEWAY_BASE_URL;
  const model = env.AI_GATEWAY_MODEL || env.AI_MODEL || "@makers/deepseek-v4-flash";
  const cacheKey = `${baseURL ?? ""}::${apiKey ?? ""}::${model}`;

  let cached = _modelCache.get(cacheKey);
  if (cached) return cached;

  cached = new ChatOpenAI({
    model,
    apiKey: apiKey!,
    configuration: {
      baseURL: baseURL!,
    },
    timeout: 300_000,
  });
  _modelCache.set(cacheKey, cached);
  return cached;
}

// ─── Logger ───

export function createLogger(name: string) {
  return {
    log(...args: unknown[]) { console.log(`[${name}][${new Date().toISOString()}]`, ...args); },
    error(...args: unknown[]) { console.error(`[${name}][${new Date().toISOString()}]`, ...args); },
  };
}

// ─── SSE Helpers ───

export function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function createSSEResponse(generator: AsyncGenerator<string>, signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(sseEvent({ type: "ping", ts: Date.now() }))); } catch {}
      }, 5_000);
      try {
        for await (const chunk of generator) {
          if (signal?.aborted) break;
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (e) {
        const error = e as Error;
        if (error.name !== "AbortError" && !signal?.aborted) {
          controller.enqueue(encoder.encode(sseEvent({ type: "error_message", content: error.message })));
        }
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
    cancel() {},
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ─── Order Types ───

export type OrderStatus = "pending" | "shipped" | "delivered" | "refund_requested" | "refund_approved" | "refund_completed" | "exchange_requested" | "exchange_shipped";

export interface OrderItem {
  productId: string;
  name: string;
  specs: string;
  quantity: number;
  price: number;
  image?: string;
}

export interface Order {
  orderId: string;
  userId: string;
  items: OrderItem[];
  totalAmount: number;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  trackingNumber?: string;
  carrier?: string;
  refundReason?: string;
  refundAmount?: number;
  exchangeReason?: string;
  exchangeNewItem?: string;
}

// ─── Order Persistence ───

const ORDER_NAMESPACE = ["aftersales", "orders"];

export async function getOrder(context: AgentContext, orderId: string): Promise<Order | null> {
  try {
    const item = await (context.store.langgraphStore as BaseStore).get(ORDER_NAMESPACE, orderId);
    if (item?.value) return item.value as Order;
  } catch {}
  return null;
}

export async function saveOrder(context: AgentContext, order: Order): Promise<void> {
  try {
    await (context.store.langgraphStore as BaseStore).put(ORDER_NAMESPACE, order.orderId, { ...order });
  } catch (e) {
    createLogger("store").error("Failed to save order:", e);
  }
}

export async function listUserOrders(context: AgentContext, userId: string): Promise<Order[]> {
  try {
    const results = await (context.store.langgraphStore as BaseStore).search(ORDER_NAMESPACE, {
      filter: { userId: { $eq: userId } },
      limit: 50,
    });
    return results.map((item: any) => item.value as Order)
      .sort((a: Order, b: Order) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  } catch {}
  return [];
}
