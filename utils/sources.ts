import type { Credibility } from "@/lib/schemas";

const highAuthorityDomains = [
  // Academic & Research Publishers / Databases
  "arxiv.org",
  "nature.com",
  "thelancet.com",
  "sciencedirect.com",
  "ieee.org",
  "springer.com",
  "researchgate.net",
  "nih.gov",
  "cdc.gov",
  // Major Research Firms & Global Orgs
  "statista.com",
  "gartner.com",
  "idc.com",
  "cbinsights.com",
  "nasscom.in",
  "mckinsey.com",
  "goldmansachs.com",
  "weforum.org",
  "nielsen.com",
  "un.org",
  "who.int",
  "worldbank.org",
  "imf.org",
  "oecd.org",
  "pewresearch.org",
  "brookings.edu",
  // Major Global Journalism
  "reuters.com",
  "bloomberg.com",
  "bbc.com",
  "bbc.co.uk",
  "apnews.com",
  "nytimes.com",
  "wsj.com",
  "ft.com",
  "theguardian.com",
  "washingtonpost.com",
  "economist.com",
  "cnbc.com",
  "afp.com",
  "axios.com",
  "business-standard.com",
  // Official Technology / Company Platforms
  "openai.com",
  "google.com",
  "deepmind.google",
  "ebi.ac.uk",
  "deepmind.com",
  "research.google",
  "microsoft.com",
  "apple.com",
  "meta.com",
  "ibm.com",
  "cohere.com",
  "anthropic.com",
  "mistral.ai",
  "x.ai",
  "huggingface.co",
  "perplexity.ai",
  "github.com",
  "wikipedia.org",
  // Government & Regulatory
  "nasa.gov",
  "fda.gov",
  "ema.europa.eu",
  "sec.gov",
  "ecb.europa.eu",
  "whitehouse.gov",
  "eur-lex.europa.eu",
  "europarl.europa.eu",
  "cac.gov.cn",
  // Crypto & Financial Data
  "coinmarketcap.com",
  "coingecko.com",
  "statcounter.com",
  // Additional Science
  "sciencemag.org",
  "science.org",
  "pnas.org",
  // Company Official
  "tesla.com",
  "nvidia.com",
  "investor.nvidia.com",
  "amd.com",
  "amazon.com",
  "aboutamazon.com",
];

const mediumAuthorityDomains = [
  // Tech & Business Journalism
  "techcrunch.com",
  "wired.com",
  "forbes.com",
  "theverge.com",
  "venturebeat.com",
  "engadget.com",
  "zdnet.com",
  "cnet.com",
  "infoworld.com",
  "fastcompany.com",
  "businessinsider.com",
  "hbr.org",
  // Reputable Industry Publications / Specs
  "github.io",
  "npm.org",
  "pypi.org",
  "aws.amazon.com",
  "cloud.google.com",
  "developer.nvidia.com",
  // Additional Tech Media
  "arstechnica.com",
  "theregister.com",
  "thenextweb.com",
  "protocol.com",
  "semafor.com",
];

const lowAuthorityHints = [
  "forum",
  "reddit.com",
  "quora.com",
  "medium.com",
  "substack.com",
  "blogspot.",
  "wordpress.",
  "seo",
  "blog",
  "linkedin.com",
  "facebook.com",
  "tiktok.com",
  "instagram.com",
  "x.com",
  "threads.net",
  "youtube.com",
];

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function scoreSourceCredibility(url: string): Credibility {
  const domain = getDomain(url);

  if (!domain) {
    return "Low";
  }

  if (
    domain.endsWith(".gov") ||
    domain.endsWith(".edu") ||
    domain.endsWith(".int") ||
    highAuthorityDomains.some((trusted) => domain === trusted || domain.endsWith(`.${trusted}`))
  ) {
    return "High";
  }

  if (
    mediumAuthorityDomains.some(
      (trusted) => domain === trusted || domain.endsWith(`.${trusted}`),
    )
  ) {
    return "Medium";
  }

  if (lowAuthorityHints.some((hint) => domain.includes(hint))) {
    return "Low";
  }

  return "Low";
}

export function getSourcePriorityScore(url: string): number {
  const domain = getDomain(url);
  if (!domain) return 0;

  const isLow = lowAuthorityHints.some((hint) => domain.includes(hint));
  if (isLow) return 0;

  // 1. Government & International Orgs
  if (
    domain.endsWith(".gov") ||
    domain.endsWith(".int") ||
    ["who.int", "un.org", "worldbank.org", "imf.org", "oecd.org", "ecb.europa.eu", "whitehouse.gov", "eur-lex.europa.eu", "europarl.europa.eu", "cac.gov.cn"].some((d) => domain === d || domain.endsWith(`.${d}`))
  ) {
    return 10;
  }

  // 2. Peer-reviewed journals & academic databases
  if (
    domain.endsWith(".edu") ||
    ["thelancet.com", "nature.com", "arxiv.org", "ieee.org", "springer.com", "sciencedirect.com", "researchgate.net", "nih.gov", "cdc.gov", "ebi.ac.uk"].some((d) => domain === d || domain.endsWith(`.${d}`))
  ) {
    return 9;
  }

  // 3. Major Global News & Journalism
  if (
    ["reuters.com", "bloomberg.com", "apnews.com", "bbc.com", "bbc.co.uk", "nytimes.com", "wsj.com", "ft.com", "theguardian.com", "washingtonpost.com", "economist.com", "cnbc.com", "afp.com", "axios.com", "business-standard.com"].some((d) => domain === d || domain.endsWith(`.${d}`))
  ) {
    return 8;
  }

  // 4. Official Company Platforms
  if (
    ["openai.com", "google.com", "deepmind.google", "deepmind.com", "research.google", "microsoft.com", "apple.com", "meta.com", "ibm.com", "cohere.com", "anthropic.com", "mistral.ai", "x.ai", "huggingface.co", "perplexity.ai", "github.com", "wikipedia.org", "nvidia.com", "investor.nvidia.com", "amd.com", "tesla.com", "amazon.com", "aboutamazon.com"].some((d) => domain === d || domain.endsWith(`.${d}`))
  ) {
    return 7;
  }

  // 4b. Specialist research, market, and regulatory sources used by AI reports
  if (
    ["idc.com", "cbinsights.com", "nasscom.in", "mckinsey.com", "goldmansachs.com", "weforum.org", "statcounter.com"].some((d) => domain === d || domain.endsWith(`.${d}`))
  ) {
    return 7;
  }

  // 5. Medium Authority
  if (
    mediumAuthorityDomains.some(
      (trusted) => domain === trusted || domain.endsWith(`.${trusted}`),
    )
  ) {
    return 5;
  }

  // 6. Generic High
  if (
    highAuthorityDomains.some(
      (trusted) => domain === trusted || domain.endsWith(`.${trusted}`),
    )
  ) {
    return 3;
  }

  return 1;
}

export function evidenceStrengthScore(
  sources: Array<{ credibility: Credibility }>,
  confidence: number,
): number {
  if (sources.length === 0) {
    return 0;
  }

  const sourceScore = sources.reduce((total, source) => {
    if (source.credibility === "High") return total + 32;
    if (source.credibility === "Medium") return total + 20;
    return total + 8;
  }, 0);

  return Math.min(100, Math.round(sourceScore + confidence * 0.35));
}

export function hallucinationRiskScore(
  verdict: string,
  confidence: number,
  sources: Array<{ credibility: Credibility }>,
): number {
  let baseRisk = 15;
  if (verdict === "Inaccurate") {
    baseRisk = 25;
  } else if (verdict === "False") {
    baseRisk = 30;
  } else if (verdict === "Unverifiable") {
    baseRisk = 60;
  }

  const uncertaintyPenalty = (100 - confidence) * 0.25;
  const evidenceDeduction = evidenceStrengthScore(sources, confidence) * 0.70;
  const sourceAbsencePenalty = sources.length === 0 ? 30 : 0;

  const rawScore = baseRisk + uncertaintyPenalty - evidenceDeduction + sourceAbsencePenalty;
  return Math.max(5, Math.min(95, Math.round(rawScore)));
}
