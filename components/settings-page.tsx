"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import {
  ArrowLeft,
  Loader2,
  Moon,
  RefreshCw,
  Settings,
  Sun,
} from "lucide-react";
import { cn } from "@/lib/utils";


type KeyDetail = {
  hasKey: boolean;
  isValid: boolean;
  error: string | null;
  label: string | null;
  limit?: string | null;
  rateLimits?: {
    remainingRequests: number | null;
    limitRequests: number | null;
    resetRequests: string | null;
    remainingTokens: number | null;
    limitTokens: number | null;
    resetTokens: string | null;
  } | null;
};

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [autoVerify, setAutoVerify] = useState(false);
  const [keyStatus, setKeyStatus] = useState<{
    loading: boolean;
    groq?: KeyDetail;
    openai?: KeyDetail;
    tavily?: KeyDetail;
    serper?: KeyDetail;
  }>({
    loading: true,
  });

  useEffect(() => {
    setMounted(true);
    checkApiKey();
    const stored = window.localStorage.getItem("autoVerifyOnUpload");
    setAutoVerify(stored === "true");
  }, []);

  const handleToggleAutoVerify = () => {
    const nextValue = !autoVerify;
    setAutoVerify(nextValue);
    window.localStorage.setItem("autoVerifyOnUpload", String(nextValue));
  };

  const checkApiKey = async () => {
    setKeyStatus((prev) => ({ ...prev, loading: true }));
    try {
      const res = await fetch("/api/check-key");
      const data = await res.json();
      setKeyStatus({
        loading: false,
        groq: data.groq,
        openai: data.openai,
        tavily: data.tavily,
        serper: data.serper,
      });
    } catch {
      setKeyStatus({
        loading: false,
      });
    }
  };

  if (!mounted) return null;

  return (
    <main className="min-h-screen bg-background text-foreground flex flex-col relative">
      {/* Top Header Bar */}
      <div className="w-full flex items-center justify-between px-5 pt-4 pb-0 sm:px-8 z-20">
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="text-muted-foreground hover:text-foreground transition-colors duration-200 focus:outline-none flex items-center justify-center p-1.5 rounded-md"
            title="Back to App"
            aria-label="Back to App"
          >
            <ArrowLeft className="h-4.5 w-4.5" />
          </Link>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="text-muted-foreground hover:text-foreground transition-colors duration-200 focus:outline-none flex items-center justify-center p-1.5 rounded-md"
            title="Toggle theme"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <Sun className="h-4.5 w-4.5" />
            ) : (
              <Moon className="h-4.5 w-4.5" />
            )}
          </button>
        </div>
      </div>

      <section className="relative bg-background flex-grow flex justify-center items-start pt-6 pb-20 px-5 sm:px-8">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_18%_20%,var(--ambient-a),transparent_34%),radial-gradient(circle_at_82%_10%,var(--ambient-b),transparent_28%)]" />
        
        <div className="w-full max-w-2xl flex flex-col gap-6 mt-6">
          <div className="flex items-center justify-between border-b border-border pb-4">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Settings className="h-5 w-5 text-muted-foreground" />
              Settings
            </h2>
            <button
              onClick={checkApiKey}
              disabled={keyStatus.loading}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 hover:underline"
            >
              {keyStatus.loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Refresh Status
            </button>
          </div>

          {/* Auto-verify Toggle Container */}
          <div className="border border-border bg-card rounded-xl p-5 flex items-center justify-between shadow-sm">
            <div className="space-y-1 pr-4">
              <label htmlFor="auto-verify-toggle" className="font-semibold text-sm block cursor-pointer select-none text-foreground">
                Auto-verify on upload
              </label>
              <p className="text-xs text-muted-foreground">
                Instantly start document analysis and verification as soon as a PDF is selected or dropped.
              </p>
            </div>
            
            <button
              id="auto-verify-toggle"
              type="button"
              role="switch"
              aria-checked={autoVerify}
              onClick={handleToggleAutoVerify}
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
                autoVerify ? "bg-emerald-500" : "bg-muted"
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                  autoVerify ? "translate-x-5" : "translate-x-0"
                )}
              />
            </button>
          </div>

          <div className="flex flex-col gap-4">
            {/* 1. Groq Card */}
            <div className="border border-border/80 bg-muted/20 rounded-xl p-5 space-y-3 flex flex-col justify-between">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">Groq API Key</span>
                  {keyStatus.loading ? (
                    <span className="text-xs text-muted-foreground animate-pulse">Checking...</span>
                  ) : keyStatus.groq?.hasKey ? (
                    keyStatus.groq.isValid ? (
                      <span className="text-xs font-semibold text-emerald-500">Active</span>
                    ) : (
                      <span className="text-xs font-semibold text-red-500">Error</span>
                    )
                  ) : (
                    <span className="text-xs font-semibold text-red-500/80">Missing</span>
                  )}
                </div>

                {keyStatus.groq?.error && (
                  <div className="text-[11px] text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg p-2 leading-normal">
                    {keyStatus.groq.error}
                  </div>
                )}

                {keyStatus.groq?.isValid && (
                  <div className="text-xs text-muted-foreground space-y-1.5 border-t border-border/40 pt-2.5 mt-2.5">
                    <div className="flex justify-between">
                      <span>Tier:</span>
                      <span className="font-medium text-foreground">{keyStatus.groq.limit || "Free Tier"}</span>
                    </div>

                    {keyStatus.groq.rateLimits && (
                      <div className="space-y-1 bg-muted/40 p-2 rounded-lg border border-border/40 mt-2 text-[11px]">
                        <span className="font-semibold block text-foreground uppercase tracking-wider text-[9px] mb-1">
                          Live Rate Limits
                        </span>
                        <div className="flex justify-between">
                          <span>Req remaining:</span>
                          <span className="font-medium text-foreground">
                            {keyStatus.groq.rateLimits.remainingRequests !== null
                              ? `${keyStatus.groq.rateLimits.remainingRequests.toLocaleString()} / ${keyStatus.groq.rateLimits.limitRequests?.toLocaleString()}`
                              : "--"}
                          </span>
                        </div>
                        {keyStatus.groq.rateLimits.resetRequests && (
                          <div className="flex justify-between">
                            <span>Req reset:</span>
                            <span className="font-medium text-foreground">{keyStatus.groq.rateLimits.resetRequests}</span>
                          </div>
                        )}
                        <div className="flex justify-between border-t border-border/20 pt-1 mt-1">
                          <span>Tokens remaining:</span>
                          <span className="font-medium text-foreground">
                            {keyStatus.groq.rateLimits.remainingTokens !== null
                              ? `${keyStatus.groq.rateLimits.remainingTokens.toLocaleString()} / ${keyStatus.groq.rateLimits.limitTokens?.toLocaleString()}`
                              : "--"}
                          </span>
                        </div>
                        {keyStatus.groq.rateLimits.resetTokens && (
                          <div className="flex justify-between">
                            <span>Tokens reset:</span>
                            <span className="font-medium text-foreground">{keyStatus.groq.rateLimits.resetTokens}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {!keyStatus.groq?.hasKey && !keyStatus.loading && (
                <p className="text-[11px] text-muted-foreground mt-2">
                  Add <code className="bg-background px-1 py-0.5 rounded border border-border">GROQ_API_KEY</code> to environment.
                </p>
              )}
            </div>

            {/* 2. OpenAI Card */}
            <div className="border border-border/80 bg-muted/20 rounded-xl p-5 space-y-3 flex flex-col justify-between">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">OpenAI API Key <span className="text-xs font-normal text-muted-foreground ml-1.5">(Optional)</span></span>
                  {keyStatus.loading ? (
                    <span className="text-xs text-muted-foreground animate-pulse">Checking...</span>
                  ) : keyStatus.openai?.hasKey ? (
                    keyStatus.openai.isValid ? (
                      <span className="text-xs font-semibold text-emerald-500">Active</span>
                    ) : (
                      <span className="text-xs font-semibold text-red-500">Error</span>
                    )
                  ) : (
                    <span className="text-xs font-semibold text-muted-foreground/70">Optional / Missing</span>
                  )}
                </div>

                {keyStatus.openai?.error && (
                  <div className="text-[11px] text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg p-2 leading-normal">
                    {keyStatus.openai.error}
                  </div>
                )}

                {keyStatus.openai?.isValid && (
                  <div className="text-xs text-muted-foreground space-y-1.5 border-t border-border/40 pt-2.5 mt-2.5">
                    <div className="flex justify-between">
                      <span>Label:</span>
                      <span className="font-medium text-foreground">{keyStatus.openai.label || "OpenAI Key"}</span>
                    </div>

                    {keyStatus.openai.rateLimits && (
                      <div className="space-y-1 bg-muted/40 p-2 rounded-lg border border-border/40 mt-2 text-[11px]">
                        <span className="font-semibold block text-foreground uppercase tracking-wider text-[9px] mb-1">
                          Live Rate Limits
                        </span>
                        <div className="flex justify-between">
                          <span>Req remaining:</span>
                          <span className="font-medium text-foreground">
                            {keyStatus.openai.rateLimits.remainingRequests !== null
                              ? `${keyStatus.openai.rateLimits.remainingRequests.toLocaleString()} / ${keyStatus.openai.rateLimits.limitRequests?.toLocaleString()}`
                              : "--"}
                          </span>
                        </div>
                        {keyStatus.openai.rateLimits.resetRequests && (
                          <div className="flex justify-between">
                            <span>Req reset:</span>
                            <span className="font-medium text-foreground">{keyStatus.openai.rateLimits.resetRequests}</span>
                          </div>
                        )}
                        <div className="flex justify-between border-t border-border/20 pt-1 mt-1">
                          <span>Tokens remaining:</span>
                          <span className="font-medium text-foreground">
                            {keyStatus.openai.rateLimits.remainingTokens !== null
                              ? `${keyStatus.openai.rateLimits.remainingTokens.toLocaleString()} / ${keyStatus.openai.rateLimits.limitTokens?.toLocaleString()}`
                              : "--"}
                          </span>
                        </div>
                        {keyStatus.openai.rateLimits.resetTokens && (
                          <div className="flex justify-between">
                            <span>Tokens reset:</span>
                            <span className="font-medium text-foreground">{keyStatus.openai.rateLimits.resetTokens}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {!keyStatus.openai?.hasKey && !keyStatus.loading && (
                <p className="text-[11px] text-muted-foreground mt-2">
                  Optional. Add <code className="bg-background px-1 py-0.5 rounded border border-border">OPENAI_API_KEY</code> to your environment if you want to verify using OpenAI models.
                </p>
              )}
            </div>

            {/* 3. Tavily Card */}
            <div className="border border-border/80 bg-muted/20 rounded-xl p-5 space-y-3 flex flex-col justify-between">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">Tavily Search Key</span>
                  {keyStatus.loading ? (
                    <span className="text-xs text-muted-foreground animate-pulse">Checking...</span>
                  ) : keyStatus.tavily?.hasKey ? (
                    keyStatus.tavily.isValid ? (
                      <span className="text-xs font-semibold text-emerald-500">Active</span>
                    ) : (
                      <span className="text-xs font-semibold text-red-500">Error</span>
                    )
                  ) : (
                    <span className="text-xs font-semibold text-red-500/80">Missing</span>
                  )}
                </div>

                {keyStatus.tavily?.error && (
                  <div className="text-[11px] text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg p-2 leading-normal">
                    {keyStatus.tavily.error}
                  </div>
                )}

                {keyStatus.tavily?.isValid && (
                  <div className="text-xs text-muted-foreground space-y-1.5 border-t border-border/40 pt-2.5 mt-2.5">
                    <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                      Search verification engine is operational.
                    </p>
                  </div>
                )}
              </div>

              {!keyStatus.tavily?.hasKey && !keyStatus.loading && (
                <p className="text-[11px] text-muted-foreground mt-2">
                  Add <code className="bg-background px-1 py-0.5 rounded border border-border">TAVILY_API_KEY</code> to environment.
                </p>
              )}
            </div>

            {/* 4. Serper Card */}
            <div className="border border-border/80 bg-muted/20 rounded-xl p-5 space-y-3 flex flex-col justify-between">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">Serper Search Key</span>
                  {keyStatus.loading ? (
                    <span className="text-xs text-muted-foreground animate-pulse">Checking...</span>
                  ) : keyStatus.serper?.hasKey ? (
                    keyStatus.serper.isValid ? (
                      <span className="text-xs font-semibold text-emerald-500">Active</span>
                    ) : (
                      <span className="text-xs font-semibold text-red-500">Error</span>
                    )
                  ) : (
                    <span className="text-xs font-semibold text-red-500/80">Missing</span>
                  )}
                </div>

                {keyStatus.serper?.error && (
                  <div className="text-[11px] text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg p-2 leading-normal">
                    {keyStatus.serper.error}
                  </div>
                )}

                {keyStatus.serper?.isValid && (
                  <div className="text-xs text-muted-foreground space-y-1.5 border-t border-border/40 pt-2.5 mt-2.5">
                    <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                      Google search indexing engine is operational.
                    </p>
                  </div>
                )}
              </div>

              {!keyStatus.serper?.hasKey && !keyStatus.loading && (
                <p className="text-[11px] text-muted-foreground mt-2">
                  Add <code className="bg-background px-1 py-0.5 rounded border border-border">SERPER_API_KEY</code> to environment.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
