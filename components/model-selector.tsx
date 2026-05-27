"use client";

import { Check } from "lucide-react";

import { DEFAULT_MODEL, MODEL_OPTIONS, type GeminiModel } from "@/lib/models";
import { cn } from "@/lib/utils";

export const MODEL_STORAGE_KEY = "2see:selected-model";

export function ModelSelector({
  value,
  onChange,
  disabled,
}: {
  value: GeminiModel;
  onChange: (model: GeminiModel) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {MODEL_OPTIONS.map((option) => {
        const isSelected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.id)}
            className={cn(
              "flex min-h-20 items-start justify-between rounded-lg border p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50",
              isSelected
                ? "border-emerald-900 bg-emerald-950 text-emerald-50 dark:bg-emerald-500 dark:text-emerald-950 dark:border-emerald-500 shadow-sm"
                : "border-border bg-card text-foreground hover:bg-muted",
            )}
          >
            <span>
              <span
                className={cn(
                  "block text-sm font-semibold",
                  isSelected ? "text-emerald-50 dark:text-emerald-950" : "text-foreground",
                )}
              >
                {option.label}
              </span>
              <span
                className={cn(
                  "mt-1 block text-xs",
                  isSelected ? "text-emerald-300/80 dark:text-emerald-950/80" : "text-muted-foreground",
                )}
              >
                {option.note}
              </span>
            </span>
            {isSelected ? (
              <Check className="h-4 w-4 shrink-0 text-emerald-400 dark:text-emerald-950" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function getStoredModel(): GeminiModel {
  if (typeof window === "undefined") {
    return DEFAULT_MODEL;
  }

  const stored = window.localStorage.getItem(MODEL_STORAGE_KEY);
  const match = MODEL_OPTIONS.find((option) => option.id === stored);
  return match?.id ?? DEFAULT_MODEL;
}
