import type { AgentContext } from '@edgeone/types';
/**
 * Document Upload Agent — handles document upload for the after-sales knowledge base.
 *
 * Migrated from cloud-functions/upload to bypass the 30s cloud-function timeout
 * (large documents need significant LLM time for summary generation).
 *
 * Accepts POST with:
 * - file (base64 content) + filename + category
 * - OR text + title + category (for inline text input)
 *
 * Streams progress via SSE: parsing → summarizing → saved.
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createLogger, createModel, sseEvent, createSSEResponse } from "../_shared";
import { saveDoc, findDocByFilename, removeDoc, type DocCategory } from "../../lib/doc-store";
import { parseDocument } from "../../lib/parser";
import { t, getLocale, type Locale } from "../_i18n";

const logger = createLogger("upload");

const VALID_CATEGORIES: DocCategory[] = ["faq", "policy", "product", "order_doc"];

/**
 * Generate a summary and keywords for a document using AI Gateway.
 */
type AgentEnv = Record<string, string | undefined>;

async function generateSummary(
  content: string,
  filename: string,
  category: string,
  locale: Locale,
  env: AgentEnv
): Promise<{ summary: string; keywords: string[] }> {
  const model = createModel(env);

  const truncated = content.length > 8000 ? content.slice(0, 8000) + "\n...[truncated]" : content;

  const sysPrompt = locale === "en"
    ? `You are a document summarizer. Given a document, generate:
1. A concise summary (within 200 words) describing the core content and purpose.
2. 5-10 keywords covering the main topics.

Document category: ${category}

Output STRICT JSON only (no other text):
{"summary": "...", "keywords": ["k1", "k2", ...]}`
    : `你是一个文档摘要助手。给定一个文档，生成：
1. 简明摘要（200字以内），概述核心内容和用途。
2. 5-10个关键词，涵盖文档的主要主题。

文档分类：${category}

输出严格 JSON 格式（不含其他文本）：
{"summary": "...", "keywords": ["关键词1", "关键词2", ...]}`;
  const userPrompt = locale === "en"
    ? `Filename: ${filename}\n\nContent:\n${truncated}`
    : `文件名: ${filename}\n\n文档内容:\n${truncated}`;

  const response = await model.invoke([
    new SystemMessage(sysPrompt),
    new HumanMessage(userPrompt),
  ]);

  const text = typeof response.content === "string" ? response.content : "";

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary: parsed.summary || text.slice(0, 400),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      };
    }
  } catch {}

  return {
    summary: text.slice(0, 400),
    keywords: [],
  };
}

export async function onRequest(context: AgentContext) {
  const { request } = context;
  const env = context.env ?? {};
  const body = (request?.body ?? {}) as Record<string, any>;
  const { file, filename, category, text, title } = body;
  const locale = getLocale(body);

  // Agents access the store directly via context.store
  const store = context.store ?? null;
  if (!store) {
    return new Response(JSON.stringify({
      error: "STORE_NOT_CONFIGURED",
      message: "Storage is not available. Deploy to EdgeOne Makers for automatic configuration.",
    }), { status: 503, headers: { "Content-Type": "application/json" } });
  }

  if (!category || !VALID_CATEGORIES.includes(category)) {
    return new Response(JSON.stringify({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const hasFile = file && filename;
  const hasText = text && title;
  if (!hasFile && !hasText) {
    return new Response(JSON.stringify({ error: "Missing required fields. Provide (file + filename) or (text + title)." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const docFilename = filename || title;
  const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  async function* streamUpload(): AsyncGenerator<string> {
    try {
      // Step 1: Parsing
      yield sseEvent({ type: "progress", stage: "parsing", message: t(locale, "upload.parsing", { filename: docFilename }) });

      let extractedText: string;

      if (hasText) {
        extractedText = text;
      } else {
        extractedText = await parseDocument(Buffer.from(file, "base64"), filename);
      }

      if (!extractedText || extractedText.trim().length < 10) {
        yield sseEvent({ type: "error_message", content: t(locale, "upload.noText") });
        return;
      }

      logger.log(`Extracted ${extractedText.length} chars from ${docFilename}`);
      yield sseEvent({ type: "progress", stage: "parsed", message: t(locale, "upload.parseDone", { chars: extractedText.length }) });

      // Step 2: Check for existing document (deduplication)
      const existing = await findDocByFilename(store, category, docFilename);
      const finalDocId = existing ? existing.docId : docId;
      if (existing) {
        logger.log(`Overwriting existing document: ${docFilename} (${existing.docId})`);
        await removeDoc(store, category, existing.docId);
      }

      // Step 3: Generate summary
      yield sseEvent({ type: "progress", stage: "summarizing", message: t(locale, "upload.summarizing") });

      const { summary, keywords } = await generateSummary(extractedText, docFilename, category, locale, env);
      logger.log(`Summary generated for ${docFilename}: ${summary.slice(0, 60)}...`);

      // Step 4: Save to store
      yield sseEvent({ type: "progress", stage: "saving", message: t(locale, "upload.saving") });

      await saveDoc(store, category, finalDocId, docFilename, extractedText, summary, keywords);

      // Step 5: Done
      yield sseEvent({
        type: "complete",
        data: {
          docId: finalDocId,
          filename: docFilename,
          category,
          summary,
          keywords,
          charCount: extractedText.length,
          overwritten: !!existing,
        },
      });
    } catch (e) {
      logger.error("Upload error:", (e as Error).message);
      yield sseEvent({ type: "error_message", content: t(locale, "upload.failure", { error: (e as Error).message }) });
    }
  }

  return createSSEResponse(streamUpload(), request.signal);
}
