"use client";

import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Download,
  FileJson,
  FilePlus2,
  Loader2,
  Moon,
  RefreshCw,
  Settings,
  Sparkles,
  StopCircle,
  Sun,
  XCircle,
} from "lucide-react";
import { AnimatePresence, motion, LayoutGroup } from "framer-motion";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import {
  ModelSelector,
} from "@/components/model-selector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type {
  ClaimType,
  NormalizedClaim,
  Report,
  Verdict,
  VerificationResult,
} from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { useModelSelection } from "@/hooks/use-model-selection";
import {
  MAX_PDF_SIZE_BYTES,
  NON_PDF_ERROR,
  PDF_MIME_TYPE,
} from "@/utils/files";
import {
  evidenceStrengthScore,
  hallucinationRiskScore,
} from "@/utils/sources";
import { calculateReportScore } from "@/utils/report-score";

type Stage =
  | "idle"
  | "uploading"
  | "parsing"
  | "extracting"
  | "verifying"
  | "complete"
  | "error";

type ClaimStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "transitioning-Verified"
  | "transitioning-Inaccurate"
  | "transitioning-False"
  | "transitioning-Unverifiable";

type ExtractResponse = {
  fileName: string;
  textLength: number;
  chunksProcessed: number;
  totalClaimsFound: number;
  claims: NormalizedClaim[];
  wasCapped: boolean;
  capNotice?: string;
};

type StreamEvent =
  | { type: "verification_started"; totalClaims: number }
  | {
      type: "claim_started";
      claimId: string;
      batchIndex: number;
      totalBatches: number;
    }
  | {
      type: "claim_completed";
      result: VerificationResult;
      batchIndex: number;
      totalBatches: number;
    }
  | { type: "batch_completed"; batchIndex: number; totalBatches: number }
  | { type: "verification_completed" }
  | { type: "verification_cancelled" }
  | { type: "verification_error"; error: string };



const springTransition = {
  type: "spring" as const,
  stiffness: 300,
  damping: 30,
  mass: 0.8,
};

const VERIFY_CLAIMS_PER_REQUEST = 3;

export function VerificationApp() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isCancelledRef = useRef(false);
  const [model, setModel] = useModelSelection();
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("Ready for a PDF.");
  const [error, setError] = useState<string | null>(null);
  const [extractData, setExtractData] = useState<ExtractResponse | null>(null);
  const [results, setResults] = useState<VerificationResult[]>([]);
  const [claimStatuses, setClaimStatuses] = useState<Record<string, ClaimStatus>>(
    {},
  );
  const [verdictFilter, setVerdictFilter] = useState<"all" | Verdict>("all");
  const [typeFilter, setTypeFilter] = useState<"all" | ClaimType>("all");
  const [exportingPdf, setExportingPdf] = useState(false);
  const [highlightedClaimId, setHighlightedClaimId] = useState<string | null>(null);

  useEffect(() => {
    if (highlightedClaimId) {
      const timer = setTimeout(() => setHighlightedClaimId(null), 2500);
      return () => clearTimeout(timer);
    }
  }, [highlightedClaimId]);

  const handleClaimClick = (claimId: string) => {
    setVerdictFilter("all");
    setTypeFilter("all");
    setHighlightedClaimId(claimId);
    setTimeout(() => {
      const element = document.getElementById(`claim-${claimId}`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 100);
  };
  const [dragActive, setDragActive] = useState(false);

  const summary = useMemo(() => {
    const counts = {
      Verified: 0,
      Inaccurate: 0,
      False: 0,
      Unverifiable: 0,
    };

    for (const result of results) {
      counts[result.verdict] += 1;
    }

    return counts;
  }, [results]);

  const filteredResults = useMemo(
    () =>
      results.filter((result) => {
        const verdictMatches =
          verdictFilter === "all" || result.verdict === verdictFilter;
        const typeMatches = typeFilter === "all" || result.type === typeFilter;
        return verdictMatches && typeMatches;
      }),
    [results, typeFilter, verdictFilter],
  );

  const isBusy =
    stage === "uploading" ||
    stage === "parsing" ||
    stage === "extracting" ||
    stage === "verifying";


  function pickFile(nextFile: File | null) {
    setError(null);

    if (!nextFile) {
      return;
    }

    const validation = validateClientFile(nextFile);
    if (validation) {
      setStage("error");
      setMessage(validation);
      setError(validation);
      setFile(null);
      return;
    }

    setFile(nextFile);
    setStage("idle");
    setProgress(0);
    setMessage(`${nextFile.name} selected.`);
    setExtractData(null);
    setResults([]);
    setClaimStatuses({});

    const autoVerify = window.localStorage.getItem("autoVerifyOnUpload") === "true";
    if (autoVerify) {
      analyzeDocument(nextFile);
    }
  }

  async function analyzeDocument(overrideFile?: File) {
    const fileToUse = overrideFile || file;
    if (!fileToUse || isBusy) {
      return;
    }

    // Create new abort controller for this analysis run
    isCancelledRef.current = false;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setError(null);
    setResults([]);
    setExtractData(null);
    setClaimStatuses({});
    setStage("uploading");
    setProgress(12);
    setMessage("Uploading PDF securely.");

    const formData = new FormData();
    formData.append("file", fileToUse);
    formData.append("model", model);

    try {
      setStage("parsing");
      setProgress(28);
      setMessage("Parsing PDF text in memory.");

      const response = await fetch("/api/extract-claims", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      const payload = await readJsonResponse<ExtractResponse | { error: string }>(
        response,
        "Claim extraction failed.",
      );

      if (!response.ok) {
        throw new Error("error" in payload ? payload.error : "Extraction failed.");
      }

      const extracted = payload as ExtractResponse;
      setStage("extracting");
      setProgress(56);
      setMessage(
        `Detected ${extracted.totalClaimsFound} factual claim${
          extracted.totalClaimsFound === 1 ? "" : "s"
        } across ${extracted.chunksProcessed} chunk${
          extracted.chunksProcessed === 1 ? "" : "s"
        }.`,
      );
      setExtractData(extracted);
      setClaimStatuses(
        Object.fromEntries(
          extracted.claims.map((claim) => [claim.id, "queued" as ClaimStatus]),
        ),
      );

      if (extracted.claims.length === 0) {
        setStage("complete");
        setProgress(100);
        setMessage("No factual, verifiable claims were detected.");
        return;
      }

      await verifyClaims(extracted);
    } catch (nextError) {
      if (nextError instanceof DOMException && nextError.name === "AbortError") {
        // User cancelled — don't show error state
        return;
      }
      const nextMessage =
        nextError instanceof Error
          ? nextError.message
          : "Document analysis failed.";
      setStage("error");
      setProgress(0);
      setMessage(nextMessage);
      setError(nextMessage);
    }
  }

  async function verifyClaims(extracted: ExtractResponse) {
    setStage("verifying");
    setProgress(64);
    setMessage("Verifying claims with live grounded search.");

    const decoder = new TextDecoder();
    let completed = 0;
    const claimChunks = chunkArray(extracted.claims, VERIFY_CLAIMS_PER_REQUEST);

    for (let chunkIndex = 0; chunkIndex < claimChunks.length; chunkIndex += 1) {
      if (isCancelledRef.current) {
        break;
      }

      const claimChunk = claimChunks[chunkIndex];
      const response = await fetch("/api/verify-claims", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          claims: claimChunk,
        }),
        signal: abortControllerRef.current?.signal,
      });

      if (!response.ok || !response.body) {
        const payload = await readJsonResponse<{ error?: string }>(
          response,
          "Verification failed to start.",
        ).catch(() => null);
        throw new Error(payload?.error ?? "Verification failed to start.");
      }

      const reader = response.body.getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const event = parseStreamEvent(part);
          if (!event) {
            continue;
          }

          if (isCancelledRef.current) continue;

          if (event.type === "claim_started") {
            setClaimStatuses((current) => ({
              ...current,
              [event.claimId]: "running",
            }));
            setMessage(
              `Verifying group ${chunkIndex + 1} of ${claimChunks.length}, batch ${event.batchIndex + 1} of ${event.totalBatches}.`,
            );
          }

          if (event.type === "claim_completed") {
            completed += 1;
            const { claim_id, verdict } = event.result;
            setResults((current) => [...current, event.result]);
            setClaimStatuses((current) => ({
              ...current,
              [claim_id]: `transitioning-${verdict}` as ClaimStatus,
            }));
            setProgress(64 + Math.round((completed / extracted.claims.length) * 36));

            setTimeout(() => {
              if (isCancelledRef.current) return;
              setClaimStatuses((current) => ({
                ...current,
                [claim_id]: "done",
              }));
            }, 1200);
          }

          if (event.type === "verification_error") {
            throw new Error(event.error);
          }

          if (event.type === "verification_cancelled") {
            throw new Error("Verification was cancelled before all claims completed.");
          }
        }
      }
    }

    if (completed < extracted.claims.length) {
      setClaimStatuses((current) => {
        const next = { ...current };
        for (const claim of extracted.claims) {
          if (next[claim.id] === "running") {
            next[claim.id] = "error";
          }
        }
        return next;
      });
      throw new Error(
        `Verification stream ended early (${completed}/${extracted.claims.length} claims completed).`,
      );
    }

    setStage("complete");
    setProgress(100);
    setMessage("Verification report ready.");
  }

  function buildReport(): Report | null {
    if (!extractData) {
      return null;
    }

    return {
      fileName: extractData.fileName,
      model,
      totalClaimsFound: extractData.totalClaimsFound,
      wasCapped: extractData.wasCapped,
      generatedAt: new Date().toISOString(),
      results,
    };
  }

  function exportJson() {
    const report = buildReport();
    if (!report) return;

    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${report.fileName.replace(/\.pdf$/i, "")}-2see-report.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function exportPdf() {
    const report = buildReport();
    if (!report || exportingPdf) return;

    setExportingPdf(true);
    setError(null);

    try {
      const response = await fetch("/api/export-report", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(report),
      });

      if (!response.ok) {
        const payload = await readJsonResponse<{ error?: string }>(
          response,
          "PDF export failed.",
        ).catch(() => null);
        throw new Error(payload?.error ?? "PDF export failed.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${report.fileName.replace(/\.pdf$/i, "")}-2see-report.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "PDF export failed.",
      );
    } finally {
      setExportingPdf(false);
    }
  }

  function reset() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setFile(null);
    setStage("idle");
    setProgress(0);
    setMessage("Ready for a PDF.");
    setError(null);
    setExtractData(null);
    setResults([]);
    setClaimStatuses({});
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function stopAnalysis() {
    // Set cancelled flag FIRST so any in-flight stream events are dropped
    isCancelledRef.current = true;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    // Snapshot results length synchronously before async state updates land
    setResults((current) => {
      const len = current.length;
      setStage(len > 0 ? "complete" : "idle");
      setProgress(len > 0 ? 100 : 0);
      setMessage(
        len > 0
          ? `Analysis stopped. ${len} claim${len === 1 ? "" : "s"} verified.`
          : "Analysis cancelled."
      );
      return current;
    });
    // Clear all non-done claim statuses
    setClaimStatuses((current) => {
      const next = { ...current };
      for (const key in next) {
        if (next[key] !== "done") {
          delete next[key];
        }
      }
      return next;
    });
  }

  async function reverifyClaim(claimId: string) {
    if (!extractData) return;
    const claimToVerify = extractData.claims.find((c) => c.id === claimId);
    if (!claimToVerify) return;

    setClaimStatuses((current) => ({
      ...current,
      [claimId]: "running",
    }));

    setResults((current) => current.filter((r) => r.claim_id !== claimId));

    try {
      const response = await fetch("/api/verify-claims", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          claims: [claimToVerify],
        }),
      });

      if (!response.ok || !response.body) {
        const payload = await readJsonResponse<{ error?: string }>(
          response,
          "Verification failed.",
        ).catch(() => null);
        throw new Error(payload?.error ?? "Verification failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const event = parseStreamEvent(part);
          if (!event) continue;

          if (event.type === "claim_completed") {
            const { verdict } = event.result;
            setResults((current) => {
              const filtered = current.filter((r) => r.claim_id !== claimId);
              return [...filtered, event.result];
            });
            setClaimStatuses((current) => ({
              ...current,
              [claimId]: `transitioning-${verdict}` as ClaimStatus,
            }));
            setTimeout(() => {
              if (isCancelledRef.current) return;
              setClaimStatuses((current) => ({
                ...current,
                [claimId]: "done",
              }));
            }, 1200);
          }
          if (event.type === "verification_error") {
            throw new Error(event.error);
          }
        }
      }
    } catch (err) {
      console.error("Single claim verification failed:", err);
      setClaimStatuses((current) => ({
        ...current,
        [claimId]: "error",
      }));
      const fallbackResult: VerificationResult = {
        claim_id: claimId,
        claim: claimToVerify.claim,
        type: claimToVerify.type,
        verdict: "Unverifiable",
        confidence: 0,
        explanation: `Single claim verification failed: ${err instanceof Error ? err.message : String(err)}`,
        corrected_fact: "",
        verified_at: new Date().toISOString(),
        sources: [],
        page_number: claimToVerify.page_number,
      };
      setResults((current) => {
        const filtered = current.filter((r) => r.claim_id !== claimId);
        return [...filtered, fallbackResult];
      });
    }
  }

  return (
    <main className="min-h-screen overflow-hidden bg-background text-foreground flex flex-col relative">
      {mounted && (
        <div className="absolute top-5 left-5 z-20 flex flex-col gap-3">
          <Link
            href="/settings"
            className="text-muted-foreground hover:text-foreground transition-colors duration-200 focus:outline-none flex items-center justify-center p-1 rounded-md"
            title="Open Settings"
            aria-label="Open Settings"
          >
            <Settings className="h-4.5 w-4.5" />
          </Link>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="text-muted-foreground hover:text-foreground transition-colors duration-200 focus:outline-none flex items-center justify-center p-1 rounded-md"
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
      )}

      <section className="relative bg-background flex-grow">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_18%_20%,var(--ambient-a),transparent_34%),radial-gradient(circle_at_82%_10%,var(--ambient-b),transparent_28%)]" />
        <div className="mx-auto grid w-full max-w-7xl gap-8 px-5 pb-16 pt-10 sm:px-8 lg:grid-cols-[0.82fr_1.18fr] lg:pb-24 lg:pt-16">
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <p className="text-sm font-bold font-mono text-muted-foreground tracking-wider">
              project 2see<span className="animate-pulse">_</span>
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-normal">
              Choose a model, upload a PDF, and watch the report build.
            </h2>
            <p className="mt-4 text-sm leading-7 text-muted-foreground">
              Instantly extract claims, cross-reference live sources, and verify the ground-truth accuracy of your documents.
            </p>
            <div className="mt-6 rounded-xl border border-border bg-card p-4 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-foreground">
                  Choose your model
                </span>
              </div>
              <ModelSelector
                value={model}
                onChange={setModel}
                disabled={isBusy}
              />
            </div>
          </aside>

          <LayoutGroup id="verification-card-flow">
            <div className="space-y-5">
              <motion.div
                layout
                transition={springTransition}
                onClick={(event) => {
                  const target = event.target as HTMLElement;
                  if (target.closest("button")) {
                    return;
                  }
                  fileInputRef.current?.click();
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragActive(false);
                  pickFile(event.dataTransfer.files.item(0));
                }}
                className={cn(
                  "rounded-2xl border border-dashed border-border bg-card p-5 transition-colors sm:p-7 cursor-pointer hover:bg-muted/10 hover:border-emerald-600/40 relative z-10",
                  dragActive && "border-foreground bg-muted",
                  !file ? "py-16 sm:py-24 flex flex-col items-center justify-center text-center gap-6" : "py-5 sm:py-6"
                )}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf"
                  className="sr-only"
                  onChange={(event) =>
                    pickFile(event.currentTarget.files?.item(0) ?? null)
                  }
                />
                {!file ? (
                  <motion.div
                    layout="position"
                    transition={springTransition}
                    className="flex flex-col items-center gap-4 max-w-sm"
                  >
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted text-emerald-600">
                      <FilePlus2 className="h-8 w-8" />
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-foreground">
                        Drop a PDF to verify
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        PDF only, 20MB maximum. Uploads are not persisted.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        fileInputRef.current?.click();
                      }}
                    >
                      Browse File
                    </Button>
                  </motion.div>
                ) : (
                  <motion.div
                    layout="position"
                    transition={springTransition}
                    className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between w-full"
                  >
                    <div className="flex items-start gap-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted">
                        <FilePlus2 className="h-6 w-6 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-base font-semibold">
                          {file.name}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          PDF only, 20MB maximum. Uploads are not persisted.
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isBusy}
                      >
                        Browse
                      </Button>
                      {isBusy ? (
                        <Button
                          type="button"
                          onClick={stopAnalysis}
                          className="bg-accent hover:bg-accent/90 text-background border border-accent/20 shadow-sm"
                        >
                          <StopCircle className="h-4 w-4 text-background/80" />
                          Stop
                        </Button>
                      ) : (
                          <Button
                          type="button"
                          onClick={() => analyzeDocument()}
                          disabled={!file}
                          className="bg-emerald-950 hover:bg-emerald-900 text-emerald-50 border border-emerald-900/20 shadow-sm disabled:opacity-45 dark:bg-emerald-500 dark:hover:bg-emerald-400 dark:text-emerald-950 dark:border-transparent"
                        >
                          <Sparkles className="h-4 w-4 text-emerald-50/80 dark:text-emerald-950/80" />
                          Analyze
                        </Button>
                      )}
                    </div>
                  </motion.div>
                )}
              </motion.div>

              <AnimatePresence>
                {(file || extractData) && (
                  <motion.div
                    layout
                    initial={{ opacity: 0, height: 0, y: -30 }}
                    animate={{ opacity: 1, height: "auto", y: 0 }}
                    exit={{ opacity: 0, height: 0, y: -30 }}
                    transition={springTransition}
                    className="rounded-2xl border border-border bg-card p-5 overflow-hidden relative z-0"
                  >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold">{stageLabel(stage)}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
                    </div>
                    {stage === "error" ? (
                      <XCircle className="h-5 w-5 text-red-500" />
                    ) : stage === "complete" ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                    ) : isBusy ? (
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    ) : (
                      <AlertCircle className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <Progress value={progress} className="mt-4" />
                  {error ? (
                    <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
                      {error}
                    </div>
                  ) : null}
                  {extractData?.capNotice ? (
                    <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
                      {extractData.capNotice}
                    </div>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={reset}
                      disabled={isBusy}
                    >
                      Reset
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={exportJson}
                      disabled={results.length === 0}
                    >
                      <FileJson className="h-4 w-4" />
                      JSON report
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={exportPdf}
                      disabled={results.length === 0 || exportingPdf}
                    >
                      {exportingPdf ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                      PDF report
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {extractData ? (
              <ResultsDashboard
                extractData={extractData}
                results={filteredResults}
                allResults={results}
                summary={summary}
                claimStatuses={claimStatuses}
                reverifyClaim={reverifyClaim}
                onClaimClick={handleClaimClick}
                highlightedClaimId={highlightedClaimId}
                isBusy={isBusy}
              />
            ) : null}
          </div>
        </LayoutGroup>
        </div>
      </section>

      <div className="py-6 flex items-center justify-center gap-4 border-t border-border/15 bg-background/30 backdrop-blur-sm select-none">
        <span className="text-[10px] font-mono tracking-widest text-muted-foreground/60">
          v1.00
        </span>
        <span className="h-3 w-[1px] bg-border/40" />
        <a
          href="https://github.com/de2pressed/2see"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono tracking-widest text-muted-foreground hover:text-foreground transition-colors duration-200 flex items-center gap-1.5"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5 fill-current"
            aria-hidden="true"
          >
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.11.82-.26.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.33-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
          </svg>
          github
          <ArrowUpRight className="h-3 w-3 text-muted-foreground/60" />
        </a>
      </div>
    </main>
  );
}

function ResultsDashboard({
  extractData,
  results,
  allResults,
  summary,
  claimStatuses,
  reverifyClaim,
  onClaimClick,
  highlightedClaimId,
  isBusy,
}: {
  extractData: ExtractResponse;
  results: VerificationResult[];
  allResults: VerificationResult[];
  summary: Record<Verdict, number>;
  claimStatuses: Record<string, ClaimStatus>;
  reverifyClaim?: (claimId: string) => void;
  onClaimClick: (claimId: string) => void;
  highlightedClaimId: string | null;
  isBusy: boolean;
}) {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Claims detected" value={extractData.totalClaimsFound} />
        <Metric label="Verified" value={summary.Verified} />
        <Metric label="Inaccurate" value={summary.Inaccurate} />
        <Metric label="False" value={summary.False} />
        <Metric label="Unverifiable" value={summary.Unverifiable} />
      </div>



      <VerificationTimeline
        claims={extractData.claims}
        results={allResults}
        claimStatuses={claimStatuses}
        onClaimClick={onClaimClick}
      />

      <div className="space-y-3">
        <AnimatePresence initial={false}>
          {results.map((result) => (
            <ClaimCard
              key={result.claim_id}
              result={result}
              reverifyClaim={reverifyClaim}
              status={claimStatuses[result.claim_id]}
              highlighted={highlightedClaimId === result.claim_id}
            />
          ))}
        </AnimatePresence>
        {isBusy && extractData.claims.filter((claim) => !allResults.some((r) => r.claim_id === claim.id)).length > 0 && (
          <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground space-y-3">
            <h4 className="font-semibold text-foreground border-b border-border pb-2">Pending / Unverified Claims</h4>
            {extractData.claims
              .filter((claim) => !allResults.some((r) => r.claim_id === claim.id))
              .map((claim) => {
                const status = claimStatuses[claim.id] ?? "queued";
                return (
                  <div
                    key={claim.id}
                    id={`claim-${claim.id}`}
                    className={cn(
                      "flex items-center justify-between border-b border-border py-3 last:border-0 rounded-lg px-2 transition-all duration-500",
                      highlightedClaimId === claim.id
                        ? "bg-emerald-500/10 border border-emerald-500/30"
                        : "border-transparent"
                    )}
                  >
                    <span className="text-foreground max-w-xl">{claim.claim}</span>
                    <div className="flex items-center gap-3">
                      <Badge variant={status === "running" ? "medium" : status === "error" ? "falseVerdict" : "neutral"}>
                        {status}
                      </Badge>
                      {reverifyClaim && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => reverifyClaim(claim.id)}
                          disabled={status === "running"}
                          className="h-7 px-3 text-xs"
                        >
                          {status === "running" ? (
                            <>
                              <Loader2 className="h-3 w-3 animate-spin mr-1" />
                              Verifying
                            </>
                          ) : (
                            <>
                              <RefreshCw className="h-3 w-3 mr-1" />
                              Verify Claim
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}

function ClaimCard({
  result,
  reverifyClaim,
  status,
  highlighted,
}: {
  result: VerificationResult;
  reverifyClaim?: (claimId: string) => void;
  status?: ClaimStatus;
  highlighted?: boolean;
}) {
  const evidence = evidenceStrengthScore(result.sources, result.confidence);
  const risk = hallucinationRiskScore(
    result.verdict,
    result.confidence,
    result.sources,
  );

  return (
    <motion.article
      id={`claim-${result.claim_id}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "rounded-2xl border bg-card p-5 transition-all duration-500",
        highlighted
          ? "border-emerald-500 ring-2 ring-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.15)] scale-[1.01]"
          : "border-border"
      )}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={verdictVariant(result.verdict)}>{result.verdict}</Badge>
            <Badge variant="neutral">{result.type}</Badge>
            {result.page_number !== undefined && (
              <Badge variant="neutral" className="border-border/60 bg-muted/30">
                Page {result.page_number}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {new Date(result.verified_at).toLocaleString()}
            </span>
            {result.evidence_status ? (
              <Badge variant="neutral" className="border-border/60 bg-muted/30">
                Evidence: {formatStatusLabel(result.evidence_status)}
              </Badge>
            ) : null}
            {result.retrieval_status ? (
              <Badge variant="neutral" className="border-border/60 bg-muted/30">
                Retrieval: {formatStatusLabel(result.retrieval_status)}
              </Badge>
            ) : null}
            {reverifyClaim && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => reverifyClaim(result.claim_id)}
                disabled={status === "running"}
                className="h-6 gap-1 px-2 text-xs font-normal"
              >
                {status === "running" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    <span>Verifying...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-3 w-3 text-muted-foreground" />
                    <span>Re-verify</span>
                  </>
                )}
              </Button>
            )}
          </div>
          <h3 className="mt-4 text-lg font-semibold leading-7">{result.claim}</h3>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {result.explanation}
          </p>
          {(result.reason_codes?.length || result.duration_ms !== undefined) ? (
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {result.reason_codes?.length ? `Reason: ${result.reason_codes.map(formatStatusLabel).join(", ")}` : ""}
              {result.reason_codes?.length && result.duration_ms !== undefined ? " | " : ""}
              {result.duration_ms !== undefined ? `Duration: ${(result.duration_ms / 1000).toFixed(1)}s` : ""}
            </p>
          ) : null}
          {result.corrected_fact ? (
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
              Corrected fact: {result.corrected_fact}
            </div>
          ) : null}
        </div>
        <div className="grid min-w-56 gap-3">
          <Signal label="AI confidence" value={result.confidence} />
          <Signal label="Evidence strength" value={evidence} />
          <Signal label="Hallucination risk" value={risk} inverse />
        </div>
      </div>

      <details className="mt-5 rounded-lg border border-border bg-background p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Raw evidence ({result.sources.length})
        </summary>
        <div className="mt-4 space-y-3">
          {result.sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No trustworthy grounded sources were returned.
            </p>
          ) : (
            result.sources.map((source) => (
              <div
                key={`${result.claim_id}-${source.url}`}
                className="rounded-lg border border-border bg-card p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={credibilityVariant(source.credibility)}>
                    {source.credibility} credibility
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {source.domain}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(source.retrieved_at).toLocaleString()}
                  </span>
                </div>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 block text-sm font-semibold underline-offset-4 hover:underline"
                >
                  {source.title}
                </a>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {source.snippet}
                </p>
              </div>
            ))
          )}
        </div>
      </details>
    </motion.article>
  );
}

function VerificationTimeline({
  claims,
  results,
  claimStatuses,
  onClaimClick,
}: {
  claims: NormalizedClaim[];
  results: VerificationResult[];
  claimStatuses: Record<string, ClaimStatus>;
  onClaimClick: (claimId: string) => void;
}) {
  const resultsMap = useMemo(() => new Map(results.map(r => [r.claim_id, r])), [results]);
  const reportScore = useMemo(() => calculateReportScore(results), [results]);

  return (
    <div className="rounded-2xl border border-border bg-card p-5 grid grid-cols-12 gap-6 items-center">
      <div className="col-span-9 min-w-0">
        <div>
          <p className="text-sm font-semibold">Verification timeline</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {results.length} of {claims.length} claims completed.
          </p>
        </div>
        <div className="mt-4 grid grid-cols-10 gap-1 sm:grid-cols-20">
          {claims.map((claim, index) => {
            const result = resultsMap.get(claim.id);
            const status = claimStatuses[claim.id] ?? "queued";

            const isTransitioning = status.startsWith("transitioning-");
            const targetVerdict = isTransitioning ? (status.replace("transitioning-", "") as Verdict) : null;

            return (
              <button
                key={claim.id}
                type="button"
                onClick={() => onClaimClick(claim.id)}
                title={
                  result
                    ? `Claim ${index + 1}: ${result.verdict}\n${claim.claim}`
                    : `Claim ${index + 1}: ${status.charAt(0).toUpperCase() + status.slice(1)}\n${claim.claim}`
                }
                className={cn(
                  "h-3 rounded-sm transition-all duration-1000 ease-out focus:outline-none focus:ring-1 focus:ring-ring relative overflow-hidden",
                  "hover:scale-y-125 hover:brightness-110 cursor-pointer hover:shadow-[0_0_8px_rgba(16,185,129,0.3)] active:scale-95",
                  
                  // Base background colors
                  status === "queued" && "bg-muted",
                  status === "running" && "bg-emerald-500/20",
                  status === "error" && "bg-rose-500",
                  status === "done" && result?.verdict === "Verified" && "bg-emerald-500",
                  status === "done" && result?.verdict === "Inaccurate" && "bg-amber-500",
                  status === "done" && result?.verdict === "False" && "bg-red-500",
                  status === "done" && result?.verdict === "Unverifiable" && "bg-slate-400",

                  // Transitional backgrounds
                  isTransitioning && targetVerdict === "Verified" && "bg-emerald-500/80",
                  isTransitioning && targetVerdict === "Inaccurate" && "bg-amber-500/80",
                  isTransitioning && targetVerdict === "False" && "bg-red-500/80",
                  isTransitioning && targetVerdict === "Unverifiable" && "bg-slate-400/80",
                )}
              >
                {/* Shimmer overlays */}
                {status === "running" && (
                  <div className="absolute inset-0 shimmer-overlay-running" />
                )}
                {isTransitioning && targetVerdict === "Verified" && (
                  <div className="absolute inset-0 shimmer-overlay-verified" />
                )}
                {isTransitioning && targetVerdict === "Inaccurate" && (
                  <div className="absolute inset-0 shimmer-overlay-inaccurate" />
                )}
                {isTransitioning && targetVerdict === "False" && (
                  <div className="absolute inset-0 shimmer-overlay-false" />
                )}
                {isTransitioning && targetVerdict === "Unverifiable" && (
                  <div className="absolute inset-0 shimmer-overlay-unverifiable" />
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div className="col-span-3 flex flex-col items-center justify-center text-center select-none pr-4">
        <motion.span
          key={reportScore ?? "pending"}
          initial={{ opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className={cn(
            "text-5xl font-extrabold tracking-tight tabular-nums",
            scoreTextColor(reportScore)
          )}
        >
          {reportScore === null ? "--" : reportScore}
          <span className="text-base font-semibold text-muted-foreground/60 align-super ml-0.5">/100</span>
        </motion.span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 mt-1">
          Trust Score
        </span>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <motion.div
      layout
      transition={springTransition}
      className="rounded-xl border border-border bg-card p-4"
    >
      <p className="text-3xl font-semibold">{value}</p>
      <p className="mt-1 text-sm text-muted-foreground">{label}</p>
    </motion.div>
  );
}





function Signal({
  label,
  value,
  inverse,
}: {
  label: string;
  value: number;
  inverse?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>{value}%</span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            inverse ? "bg-amber-500" : "bg-emerald-950",
          )}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}



function parseStreamEvent(part: string): StreamEvent | null {
  const line = part
    .split("\n")
    .find((item) => item.startsWith("data: "));

  if (!line) {
    return null;
  }

  try {
    return JSON.parse(line.replace(/^data:\s*/, "")) as StreamEvent;
  } catch {
    return null;
  }
}

async function readJsonResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const text = await response.text();

  if (!text.trim()) {
    throw new Error(fallbackMessage);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    if (response.status === 504 || /timed out|timeout|runtime/i.test(text)) {
      throw new Error("The request timed out on Vercel before the server returned JSON.");
    }

    const cleaned = text.replace(/\s+/g, " ").trim();
    throw new Error(cleaned ? cleaned.slice(0, 180) : fallbackMessage);
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function validateClientFile(file: File): string | null {
  if (file.type !== PDF_MIME_TYPE) {
    return NON_PDF_ERROR;
  }

  if (file.size > MAX_PDF_SIZE_BYTES) {
    return "PDF uploads are limited to 20MB.";
  }

  return null;
}

function stageLabel(stage: Stage): string {
  const labels: Record<Stage, string> = {
    idle: "Ready",
    uploading: "Uploading",
    parsing: "Parsing PDF",
    extracting: "Extracting claims",
    verifying: "Verifying evidence",
    complete: "Complete",
    error: "Needs attention",
  };

  return labels[stage];
}

function verdictVariant(verdict: Verdict) {
  if (verdict === "Verified") return "verified";
  if (verdict === "Inaccurate") return "inaccurate";
  if (verdict === "False") return "falseVerdict";
  return "unverifiable";
}



function scoreTextColor(score: number | null) {
  if (score === null) return "text-muted-foreground";
  if (score >= 70) return "text-emerald-700 dark:text-emerald-300";
  if (score >= 50) return "text-amber-700 dark:text-amber-300";
  return "text-red-700 dark:text-red-300";
}

function formatStatusLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function credibilityVariant(credibility: "High" | "Medium" | "Low") {
  if (credibility === "High") return "high";
  if (credibility === "Medium") return "medium";
  return "low";
}
