export const runtime = "nodejs";
export const maxDuration = 30;

import React from "react";
import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";

import { reportSchema, type Report } from "@/lib/schemas";

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON request." }, { status: 400 });
  }

  const parsed = reportSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Report data failed validation." },
      { status: 400 },
    );
  }

  const buffer = await renderToBuffer(<ReportDocument report={parsed.data} />);

  const responseBody = new Uint8Array(buffer.byteLength);
  responseBody.set(buffer);

  return new Response(responseBody, {
    headers: {
      "Content-Disposition": `attachment; filename="${safePdfName(parsed.data.fileName)}-2see-report.pdf"`,
      "Content-Type": "application/pdf",
    },
  });
}

function ReportDocument({ report }: { report: Report }) {
  const counts = report.results.reduce(
    (summary, result) => {
      summary[result.verdict] += 1;
      return summary;
    },
    {
      Verified: 0,
      Inaccurate: 0,
      False: 0,
      Unverifiable: 0,
    },
  );

  return (
    <Document
      title={`2see verification report - ${report.fileName}`}
      author="2see"
      subject="AI fact verification report"
    >
      <Page size="A4" style={styles.page}>
        <Text style={styles.kicker}>2see verification report</Text>
        <Text style={styles.title}>{report.fileName}</Text>
        <Text style={styles.meta}>
          Model: {report.model} | Generated:{" "}
          {new Date(report.generatedAt).toLocaleString()}
        </Text>

        <View style={styles.summaryGrid}>
          <SummaryItem label="Claims found" value={report.totalClaimsFound} />
          <SummaryItem label="Verified" value={counts.Verified} />
          <SummaryItem label="Inaccurate" value={counts.Inaccurate} />
          <SummaryItem label="False" value={counts.False} />
          <SummaryItem label="Unverifiable" value={counts.Unverifiable} />
        </View>

        {report.wasCapped ? (
          <Text style={styles.notice}>
            This report used a legacy capped claim set. Current analysis filters
            noisy candidates without imposing a fixed claim limit.
          </Text>
        ) : null}

        <View style={styles.tableHeader}>
          <Text style={[styles.cell, styles.claimCell]}>Claim</Text>
          <Text style={styles.cell}>Verdict</Text>
          <Text style={styles.cell}>Confidence</Text>
        </View>

        {report.results.map((result) => (
          <View key={result.claim_id} style={styles.claimBlock} wrap={false}>
            <View style={styles.row}>
              <Text style={[styles.cell, styles.claimCell]}>{result.claim}</Text>
              <Text style={styles.cell}>{result.verdict}</Text>
              <Text style={styles.cell}>{result.confidence}%</Text>
            </View>
            <Text style={styles.explanation}>{result.explanation}</Text>
            {result.decision_path ? (
              <Text style={styles.metaLine}>
                Decision: {result.decision_path}
                {result.comparator_verdict
                  ? ` | Comparator: ${result.comparator_verdict}`
                  : ""}
                {typeof result.search_query_count === "number"
                  ? ` | Search queries: ${result.search_query_count}`
                  : ""}
                {result.evidence_status
                  ? ` | Evidence: ${result.evidence_status}`
                  : ""}
                {result.retrieval_status
                  ? ` | Retrieval: ${result.retrieval_status}`
                  : ""}
                {typeof result.duration_ms === "number"
                  ? ` | Duration: ${(result.duration_ms / 1000).toFixed(1)}s`
                  : ""}
              </Text>
            ) : null}
            {result.reason_codes?.length ? (
              <Text style={styles.metaLine}>
                Reasons: {result.reason_codes.join(", ")}
              </Text>
            ) : null}
            {result.corrected_fact ? (
              <Text style={styles.corrected}>
                Corrected fact: {result.corrected_fact}
              </Text>
            ) : null}
            {result.sources.map((source) => (
              <Text key={source.url} style={styles.source}>
                [{source.credibility}] {source.title} - {source.url}
              </Text>
            ))}
          </View>
        ))}
      </Page>
    </Document>
  );
}

function SummaryItem({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.summaryItem}>
      <Text style={styles.summaryValue}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

function safePdfName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 80);
}

const styles = StyleSheet.create({
  page: {
    padding: 36,
    fontSize: 9,
    color: "#20231f",
    fontFamily: "Helvetica",
    backgroundColor: "#fbfbf8",
  },
  kicker: {
    color: "#5d6b56",
    fontSize: 9,
    letterSpacing: 1,
    marginBottom: 8,
    textTransform: "uppercase",
  },
  title: {
    fontSize: 24,
    marginBottom: 8,
  },
  meta: {
    color: "#667066",
    marginBottom: 18,
  },
  summaryGrid: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 18,
  },
  summaryItem: {
    borderColor: "#d7ddd1",
    borderWidth: 1,
    borderRadius: 6,
    padding: 8,
    width: "19%",
  },
  summaryValue: {
    fontSize: 15,
    marginBottom: 3,
  },
  summaryLabel: {
    color: "#667066",
  },
  notice: {
    backgroundColor: "#edf3e8",
    borderRadius: 6,
    padding: 9,
    marginBottom: 14,
    color: "#43503f",
  },
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#bfc8b9",
    paddingBottom: 6,
    marginBottom: 6,
  },
  row: {
    flexDirection: "row",
    marginBottom: 6,
  },
  cell: {
    width: "18%",
    paddingRight: 8,
  },
  claimCell: {
    width: "64%",
  },
  claimBlock: {
    borderBottomWidth: 1,
    borderBottomColor: "#e4e8df",
    paddingVertical: 9,
  },
  explanation: {
    color: "#3f463c",
    lineHeight: 1.45,
    marginBottom: 5,
  },
  metaLine: {
    color: "#667066",
    fontSize: 8,
    marginBottom: 4,
  },
  corrected: {
    color: "#7b3229",
    marginBottom: 5,
  },
  source: {
    color: "#5a6456",
    fontSize: 8,
    marginTop: 2,
  },
});
