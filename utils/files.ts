export const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;
export const PDF_MIME_TYPE = "application/pdf";
export const NON_PDF_ERROR = "Only PDF files are supported.";
export const TEXT_EXTRACTION_ERROR =
  "This PDF may be image-based or encrypted. Text extraction failed.";

export function sanitizeFilename(name: string): string {
  const fallback = "document.pdf";
  const sanitized = name
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  return sanitized || fallback;
}

export function assertPdfFile(file: File): string | null {
  if (file.type !== PDF_MIME_TYPE) {
    return NON_PDF_ERROR;
  }

  if (file.size > MAX_PDF_SIZE_BYTES) {
    return "PDF uploads are limited to 20MB.";
  }

  return null;
}
