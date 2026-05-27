# 2see

**AI-powered fact verification for PDF documents.**

Upload a PDF. Extract factual claims. Verify each one against live web evidence. Export a transparent, source-cited report.

---

## Why

Reports, whitepapers, marketing documents, and AI-generated content all contain factual claims — market sizes, funding rounds, benchmark scores, regulatory actions, historical events. Most go unchecked.

2see automates the verification pipeline: extract → search → verify → report. Every verdict is grounded in retrieved evidence with source credibility scoring, so you can see exactly *why* a claim was marked Verified, Inaccurate, False, or Unverifiable.

## How It Works

```mermaid
flowchart LR
    A[PDF Upload] --> B[Text Extraction]
    B --> C[Claim Extraction]
    C --> D[Materiality Scoring]
    D --> E[Evidence Retrieval]
    E --> F[Verdict Synthesis]
    F --> G[Report Export]

    style A fill:#f0f4ec,stroke:#5d6b56
    style G fill:#f0f4ec,stroke:#5d6b56
```

1. **PDF → Text** — Server-side extraction via `pdfjs-dist` with layout-aware line grouping and section heading detection.
2. **Text → Claims** — Llama models extract verifiable factual assertions per page. Claims are normalized, deduplicated (Jaccard + Dice trigram similarity), split into independent assertions, and merged when complementary.
3. **Claims → Scored** — Each claim is scored across 25+ materiality signals: named entities, metrics, temporal markers, attribution, financial terms, regulatory language, claim completeness, and table-relationship detection. Low-materiality fragments and derivative metrics are suppressed.
4. **Scored → Evidence** — A multi-step retrieval cascade runs per claim:
   - Deterministic queries (literal, metric-focused, entity, attribution, source-domain, official)
   - LLM-generated queries (when deterministic evidence is weak)
   - Wikipedia fallback
   - Source text fetching for top-credibility results
5. **Evidence → Verdict** — Retrieved sources are scored against a curated authority database (250+ domains across government, academic, news, and tech). A guardrail comparator pre-checks evidence before LLM synthesis. If the LLM call fails (rate limit, timeout), verdicts are derived from evidence guardrails alone.
6. **Verdict → Report** — Results stream to the client via SSE. Export as JSON (machine-readable) or PDF (formatted report with decision metadata).

## Core Capabilities

| Feature | Detail |
|---|---|
| **Claim Extraction** | Per-page extraction with multi-strategy JSON parsing, truncation repair, and Zod validation |
| **Materiality Scoring** | 25+ feature signals — metrics, entities, temporal markers, attribution, section importance, claim completeness |
| **Evidence Retrieval** | Cascading search: Tavily → Serper → Mojeek (scrape) → Wikipedia API, with result caching and source text fetching |
| **Source Authority** | 250+ curated domains across 6 tiers (government → academic → global news → official platforms → tech media → low-authority) |
| **Verdict System** | `Verified` · `Inaccurate` · `False` · `Unverifiable` — with confidence scores, corrected facts, and decision path transparency |
| **Decision Metadata** | Per-claim: `decision_path`, `evidence_status`, `retrieval_status`, `reason_codes`, `comparator_verdict`, `search_query_count`, `duration_ms` |
| **Knowledge Fallback** | When search engines return zero results, parametric model knowledge is used with a confidence cap of 65% |
| **Export** | JSON report (full metadata) or PDF report (formatted with `@react-pdf/renderer`) |
| **Model Selection** | Llama 4 Scout 17B (fast) or Llama 3.3 70B (thorough) via Groq's OpenAI-compatible API |
| **Streaming** | Server-Sent Events for real-time claim-by-claim progress with batch tracking |

## Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router, React 19) |
| Language | TypeScript 5 |
| LLM Provider | Groq (OpenAI-compatible API) |
| Models | `meta-llama/llama-4-scout-17b-16e-instruct`, `llama-3.3-70b-versatile` |
| PDF Parsing | `pdfjs-dist` (legacy build, server-side) |
| PDF Export | `@react-pdf/renderer` |
| Schema Validation | Zod 4 |
| Search APIs | Tavily, Serper, Mojeek (scrape), Wikipedia |
| Styling | Tailwind CSS 4, Radix UI primitives |
| Animations | Framer Motion |
| Testing | Vitest, Playwright |
| CI | GitHub Actions (lint → typecheck → test → build) |
| Deployment | Vercel (Node.js runtime, 60s function timeout) |

## Installation

```bash
git clone https://github.com/de2pressed/2see.git
cd 2see
npm ci
```

## Environment Variables

Create a `.env` file from the example:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | **Yes** | Groq API key for Llama model access. [Get one free →](https://console.groq.com/) |
| `OPENAI_API_KEY` | No | Optional fallback if `GROQ_API_KEY` is not set |
| `TAVILY_API_KEY` | No | Tavily search API for semantic evidence retrieval. [Get one →](https://tavily.com/) |
| `SERPER_API_KEY` | No | Serper API for Google search results. [Get one →](https://serper.dev/) |
| `DISABLE_CLAIM_CACHE` | No | Set to `1` to disable filesystem-based claim caching |
| `SEARCH_FIXTURES_DIR` | No | Path to a directory of pre-recorded search fixtures for testing |

> **Minimum viable setup:** Only `GROQ_API_KEY` is required. Without Tavily or Serper, evidence retrieval falls back to Mojeek web scraping and the Wikipedia API.

## Usage

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Select a model, upload a PDF, and start analysis.

### API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/check-key` | `GET` | Validates the configured Groq API key |
| `/api/extract-claims` | `POST` | Accepts a PDF (`multipart/form-data`), returns extracted + scored claims |
| `/api/verify-claims` | `POST` | Accepts claims JSON, returns SSE stream of verification results |
| `/api/export-report` | `POST` | Accepts a full report JSON, returns a formatted PDF |

### Report Evaluation

Compare a verification report against a golden-truth file:

```bash
node scripts/evaluate-report.mjs golden.json exported-report.json
```

Outputs verdict match rates, missing claims, forbidden verdict hits, source authority distribution, and average per-claim duration.

## Verification Output

Each verified claim includes:

```jsonc
{
  "claim_id": "claim-1",
  "claim": "Global AI market reached $196.6 billion in 2023.",
  "type": "financial",
  "verdict": "Verified",          // Verified | Inaccurate | False | Unverifiable
  "confidence": 88,               // 0–100
  "explanation": "Multiple high-authority sources confirm...",
  "corrected_fact": "",            // populated when verdict is Inaccurate or False
  "sources": [
    {
      "title": "AI Market Size Report",
      "url": "https://...",
      "domain": "statista.com",
      "credibility": "High",       // High | Medium | Low
      "snippet": "...",
      "retrieved_at": "2025-01-15T..."
    }
  ],
  "decision_path": "llm",         // guardrail | llm | fallback | knowledge
  "evidence_status": "direct",    // direct | related | weak | absent | conflicting | technical_failure
  "retrieval_status": "searched", // not_needed | searched | fallback_searched | exhausted | quota_limited | technical_failure
  "reason_codes": [],
  "duration_ms": 4200
}
```

## Project Structure

```
2see/
├── app/
│   ├── api/
│   │   ├── check-key/         # API key validation
│   │   ├── extract-claims/    # PDF upload → claim extraction
│   │   ├── verify-claims/     # Claim verification (SSE stream)
│   │   └── export-report/     # Report → PDF generation
│   ├── globals.css            # Design tokens (oklch palette, shimmer animations)
│   ├── layout.tsx             # Root layout, fonts, metadata
│   └── page.tsx               # Entry point → VerificationApp
├── components/
│   ├── verification-app.tsx   # Main UI (1400+ lines — upload, progress, results, filters, export)
│   ├── model-selector.tsx     # Llama model picker
│   └── ui/                    # Badge, Button, Progress (Radix-based)
├── services/
│   ├── openai.ts              # LLM calls, search cascade, evidence processing, verdict synthesis (~2800 lines)
│   ├── pdf.ts                 # PDF text extraction with layout-aware line grouping
│   └── verification.ts        # Batched verification orchestrator with retries
├── utils/
│   ├── claims.ts              # Materiality scoring, deduplication, claim merging (~800 lines)
│   ├── sources.ts             # Domain authority database, credibility scoring, evidence/hallucination risk
│   ├── ai.ts                  # JSON extraction, sanitization, truncation repair, Zod parsing
│   ├── chunk-text.ts          # Text chunking for long documents
│   ├── async.ts               # Concurrency-limited map, delay helper
│   └── files.ts               # PDF validation, filename sanitization
├── lib/
│   ├── schemas/index.ts       # Zod schemas for all data types
│   ├── models.ts              # Model definitions and selection helpers
│   ├── llm.ts                 # Shared completion parameters
│   ├── claim-cache.ts         # SHA-256 content-addressed claim cache
│   ├── search-fixtures.ts     # Test fixture loader for search results
│   └── utils.ts               # cn() (clsx + tailwind-merge)
├── types/
│   └── report.ts              # Re-exported schema types
├── hooks/
│   └── use-model-selection.ts # LocalStorage-backed model preference
├── scripts/
│   └── evaluate-report.mjs    # Golden-truth report evaluation harness
├── tests/                     # Vitest unit tests + fixtures
├── .github/workflows/ci.yml   # CI: lint → typecheck → test → build
└── .env.example
```

## Limitations

- **Free-tier rate limits.** Groq's free tier has token-per-minute and request-per-minute caps. Batch sizes and delays are tuned for this, but large documents may hit throttling.
- **No persistent storage.** Results exist only in the browser session. Closing the tab loses the report (export first).
- **Image-based PDFs.** Text extraction requires selectable text. Scanned/image-only PDFs will fail with a clear error.
- **Search coverage.** Verification quality depends on what's indexed and accessible to the configured search providers.
- **Model knowledge cutoff.** Knowledge-based fallback verdicts (when search fails) are limited by the model's training data cutoff.
- **Single-user.** Designed as a local or single-deployment tool. No auth, no multi-tenancy.

## Roadmap

- [ ] Batch PDF processing
- [ ] Persistent report storage
- [ ] Additional LLM provider support
- [ ] Configurable claim extraction rules
- [ ] Source page screenshot capture
- [ ] Claim diff across document versions
- [ ] API-first mode (headless verification)

## Development

```bash
npm run dev          # Start dev server
npm run lint         # ESLint
npm run typecheck    # TypeScript strict check
npm test             # Run Vitest suite
npm run build        # Production build
```

## Contributing

Contributions welcome. Open an issue first for non-trivial changes.

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-change`)
3. Commit with clear messages
4. Open a pull request against `main`

All PRs must pass the CI pipeline (lint, typecheck, test, build).

## License

MIT
