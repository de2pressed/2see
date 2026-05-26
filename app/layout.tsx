import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { ThemeProvider } from "@/components/theme-provider";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://2see.vercel.app"),
  title: {
    default: "2see - AI Fact Verification Platform",
    template: "%s | 2see",
  },
  description:
    "Upload PDFs, extract factual claims, verify them with live grounded evidence, and export transparent reports.",
  keywords: [
    "AI fact checking",
    "PDF verification",
    "Groq Llama verification",
    "misinformation detection",
    "claim verification",
  ],
  openGraph: {
    title: "2see - See what's actually true.",
    description:
      "AI-powered fact verification for reports, marketing content, and generated documents.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
