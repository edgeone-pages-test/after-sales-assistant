import type { AgentContext } from '@edgeone/types';
import type { BaseStore } from '@langchain/langgraph';
/**
 * Order storage utilities.
 * Orders are seeded via seed-demo (not auto-seeded as mock data).
 *
 * Storage layout (mirrors doc-store's manifest pattern):
 *   namespace ["aftersales", "orders"]           key: orderId  → Order
 *   namespace ["aftersales", "orders_manifest"]  key: "all"    → { ids: string[] }
 *
 * The manifest pattern avoids relying on `kv.search()` for listing,
 * which is not reliably supported in all EdgeOne KV implementations.
 */
import type { Order } from "../_shared";

const ORDERS_NAMESPACE = ["aftersales", "orders"];
const ORDERS_MANIFEST_NAMESPACE = ["aftersales", "orders_manifest"];
const MANIFEST_KEY = "all";

// ─── Manifest Helpers ───

async function readManifest(kv: any): Promise<string[]> {
  try {
    const item = await kv.get(ORDERS_MANIFEST_NAMESPACE, MANIFEST_KEY);
    if (item?.value?.ids && Array.isArray(item.value.ids)) {
      return item.value.ids as string[];
    }
  } catch {}
  return [];
}

async function writeManifest(kv: any, ids: string[]): Promise<void> {
  await kv.put(ORDERS_MANIFEST_NAMESPACE, MANIFEST_KEY, { ids });
}

async function addToManifest(kv: any, orderId: string): Promise<void> {
  try {
    const ids = await readManifest(kv);
    if (!ids.includes(orderId)) {
      await writeManifest(kv, [...ids, orderId]);
    }
  } catch {}
}

// ─── Public API ───

/** Get a single order by ID */
export async function getOrder(context: AgentContext, orderId: string): Promise<Order | null> {
  try {
    const kv = context.store.langgraphStore as BaseStore;
    const item = await kv.get(ORDERS_NAMESPACE, orderId);
    return (item?.value as Order) ?? null;
  } catch {}
  return null;
}

/** Save/update an order (also updates the manifest) */
export async function saveOrder(context: AgentContext, order: Order): Promise<void> {
  const kv = context.store.langgraphStore as BaseStore;
  await kv.put(ORDERS_NAMESPACE, order.orderId, { ...order });
  await addToManifest(kv, order.orderId);
}

/** List all orders for a user — manifest-based, no search needed */
export async function listUserOrders(store: any, userId = "default"): Promise<Order[]> {
  try {
    const kv = store.langgraphStore as BaseStore;
    const ids = await readManifest(kv);
    if (ids.length === 0) return [];
    const orders = await Promise.all(
      ids.map(async (id) => {
        const item = await kv.get(ORDERS_NAMESPACE, id).catch(() => null);
        return (item?.value as Order) || null;
      })
    );
    return orders
      .filter(Boolean)
      .filter((o) => !userId || (o as Order).userId === userId) as Order[];
  } catch {}
  return [];
}

// Export internal helpers for seed-demo / nodes
export { ORDERS_NAMESPACE, ORDERS_MANIFEST_NAMESPACE, MANIFEST_KEY, readManifest, writeManifest };
