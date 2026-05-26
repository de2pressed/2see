"use client";

import { useEffect, useState } from "react";

import {
  getStoredModel,
  MODEL_STORAGE_KEY,
} from "@/components/model-selector";
import type { GeminiModel } from "@/lib/models";
import { DEFAULT_MODEL } from "@/lib/models";

export function useModelSelection() {
  const [model, setModel] = useState<GeminiModel>(DEFAULT_MODEL);

  useEffect(() => {
    setModel(getStoredModel());
  }, []);

  useEffect(() => {
    window.localStorage.setItem(MODEL_STORAGE_KEY, model);
  }, [model]);

  return [model, setModel] as const;
}
