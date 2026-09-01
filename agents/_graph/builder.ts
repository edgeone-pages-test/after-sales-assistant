import type { AgentContext } from '@edgeone/types';
/**
 * Build the after-sales LangGraph state machine.
 *
 * `env` (from context.env) and `context` (full EdgeOne context) are threaded into
 * the nodes via closures, so each request binds its own values — no module-level
 * mutable state, safe under concurrency.
 */
import { StateGraph, END, START } from "@langchain/langgraph";
import { AfterSalesState } from "./state";
import { routeByIntent } from "./edges";
import {
  intentRecognition,
  faqSearch,
  lookupOrder,
  requestRefund,
  requestExchange,
  generalChat,
} from "./nodes";

type AgentEnv = Record<string, string | undefined>;

export function buildAfterSalesGraph(context: AgentContext, env: AgentEnv) {
  const graph = new StateGraph(AfterSalesState)
    .addNode("intent_recognition", (s, config) => intentRecognition(s, env, config))
    .addNode("faq_search", (s, config) => faqSearch(s, env, context, config))
    .addNode("lookup_order", (s) => lookupOrder(s, context))
    .addNode("request_refund", (s) => requestRefund(s, context))
    .addNode("request_exchange", (s) => requestExchange(s, context))
    .addNode("general_chat", (s, config) => generalChat(s, env, config))
    .addEdge(START, "intent_recognition")
    .addConditionalEdges("intent_recognition", routeByIntent, {
      faq_search: "faq_search",
      lookup_order: "lookup_order",
      request_refund: "request_refund",
      request_exchange: "request_exchange",
      general_chat: "general_chat",
    })
    .addEdge("faq_search", END)
    .addEdge("lookup_order", END)
    .addEdge("request_refund", END)
    .addEdge("request_exchange", END)
    .addEdge("general_chat", END);

  return graph.compile();
}
