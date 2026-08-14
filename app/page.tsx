"use client";

import { useState, useEffect } from "react";
import { ChatPanel } from "./components/chat-panel";
import { ManagePanel } from "./components/manage-panel";
import { DeployButtons } from "./components/deploy-buttons";
import { useT } from "../lib/i18n";

interface HealthStatus {
  ok: boolean;
  hasAiGateway: boolean;
  missing: string[];
}

export default function Home() {
  const { t, locale, setLocale } = useT();
  const [showManage, setShowManage] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);
  const [isResetting, setIsResetting] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    fetch("/health")
      .then(r => r.json())
      .then((data: HealthStatus) => setHealth(data))
      .catch(() => {});
  }, []);

  const showWarning = health && !health.ok;

  const handleReset = async () => {
    if (isResetting) return;

    setShowResetModal(false);
    setIsResetting(true);
    try {
      const key = "after-sales-conversation-id";
      const conversationId = localStorage.getItem(key) || crypto.randomUUID();
      await fetch("/stop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "makers-conversation-id": conversationId,
        },
        body: JSON.stringify({ conversation_id: conversationId }),
      }).catch(() => {});
      const response = await fetch("/reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "makers-conversation-id": conversationId,
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) throw new Error("Reset failed");

      localStorage.removeItem(key);
      setShowManage(false);
      setResetVersion(version => version + 1);
    } catch {
      window.alert(t("ui.header.resetFailed"));
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <main className="h-screen flex flex-col bg-[#f7f8fa]">
      {/* Env config warning banner */}
      {showWarning && (
        <div className="flex-shrink-0 bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center gap-2.5">
          <span className="text-amber-500 text-sm flex-shrink-0">⚠️</span>
          <div className="flex-1 min-w-0">
            <span className="text-[12px] text-amber-800 font-medium">{t("ui.warn.envMissing")}</span>
            {!health.hasAiGateway && (health.missing?.length ?? 0) > 0 && (
              <span className="text-[11px] text-amber-600 ml-1.5">
                {t("ui.warn.missing", { names: (health.missing ?? []).join(locale === "en" ? ", " : "、") })}
              </span>
            )}
          </div>
          <button
            onClick={() => setHealth(h => h ? { ...h, ok: true } : h)}
            className="flex-shrink-0 text-amber-400 hover:text-amber-600 text-sm leading-none"
          >✕</button>
        </div>
      )}

      {/* Header */}
      <header className="flex-shrink-0 h-14 bg-white border-b border-gray-200/80 px-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xs font-bold shadow-sm">
            AI
          </div>
          <div>
            <h1 className="text-[15px] font-semibold text-gray-900 leading-tight">{t("ui.header.title")}</h1>
            <p className="text-[11px] text-gray-400 leading-tight">{t("ui.header.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <DeployButtons
            templateSlug="after-sales-assistant"
            githubUrl="https://github.com/edgeone-pages-test/after-sales-assistant"
            lang={locale}
          />
          <button
            onClick={() => setShowResetModal(true)}
            disabled={isResetting}
            className="text-[11px] px-2.5 py-1 rounded-md border border-red-200 text-red-600 font-medium hover:bg-red-50 transition-colors disabled:opacity-50"
            title={t("ui.header.resetConfirm")}
          >
            {isResetting ? t("ui.header.resetting") : t("ui.header.reset")}
          </button>
          <button
            onClick={() => setLocale(locale === "en" ? "zh" : "en")}
            className="text-[11px] px-2.5 py-1 rounded-md border border-gray-200 text-gray-600 font-medium hover:bg-gray-50 transition-colors"
            title={locale === "en" ? "切换到中文" : "Switch to English"}
          >
            {t("ui.header.langSwitch")}
          </button>
          <button
            onClick={() => setShowManage(!showManage)}
            className={`text-xs px-3.5 py-1.5 rounded-lg font-medium transition-all ${
              showManage
                ? "bg-indigo-50 text-indigo-600 ring-1 ring-indigo-200"
                : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
            }`}
          >
            <span className="mr-1">📚</span> {t("ui.header.kb")}
          </button>
          <span className="flex items-center gap-1.5 text-[11px] text-gray-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            {t("ui.header.online")}
          </span>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 min-w-0">
          <ChatPanel key={resetVersion} />
        </div>

        {showManage && (
          <aside className="w-[380px] flex-shrink-0 border-l border-gray-200/80 bg-white shadow-[-4px_0_12px_rgba(0,0,0,0.03)]">
            <ManagePanel onClose={() => setShowManage(false)} />
          </aside>
        )}
      </div>

      {showResetModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm"
          onClick={() => setShowResetModal(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-modal-title"
            aria-describedby="reset-modal-description"
            className="w-full max-w-md overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
            onClick={event => event.stopPropagation()}
          >
            <div className="h-1.5 bg-gradient-to-r from-red-500 via-rose-500 to-orange-400" />
            <div className="p-6">
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600 ring-1 ring-red-100">
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m0 3.75h.008M10.29 3.86 2.82 17.1A1.9 1.9 0 0 0 4.47 20h15.06a1.9 1.9 0 0 0 1.65-2.9L13.71 3.86a1.96 1.96 0 0 0-3.42 0Z" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <h2 id="reset-modal-title" className="text-base font-semibold text-gray-900">
                    {t("ui.header.reset")}
                  </h2>
                  <p id="reset-modal-description" className="mt-2 text-sm leading-relaxed text-gray-500">
                    {t("ui.header.resetConfirm")}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={t("ui.manage.form.cancel")}
                  onClick={() => setShowResetModal(false)}
                  className="-mr-1 -mt-1 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m6 6 12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowResetModal(false)}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
                >
                  {t("ui.manage.form.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={isResetting}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("ui.header.reset")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
