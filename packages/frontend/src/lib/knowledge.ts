// Vocabulário e utilitários do módulo de conhecimento (Fases 2–4). As listas
// espelham os enums do backend; nada aqui decide permissões.

import type { BadgeTone } from "../components/ui/Badge";
import type {
  BusinessLineSlug,
  DiffClassification,
  DocType,
  DraftEntityType,
} from "./types";

export const BUSINESS_LINES: Array<{ slug: BusinessLineSlug; label: string }> = [
  { slug: "software", label: "Software" },
  { slug: "custom", label: "Soluções personalizadas" },
  { slug: "telecom", label: "Telecomunicações" },
  { slug: "cctv", label: "CCTV" },
];

const ENTITY_TYPE_LABELS: Record<DraftEntityType, string> = {
  catalog_item: "Catálogo",
  knowledge_doc: "Documento",
  rule: "Regra",
};

export function entityTypeLabel(entityType: DraftEntityType): string {
  return ENTITY_TYPE_LABELS[entityType];
}

const DOC_TYPE_LABELS: Record<DocType, string> = {
  faq: "FAQ",
  policy: "Política",
  process: "Processo",
  company_info: "Empresa",
  objection: "Objeção",
};

export function docTypeLabel(type: DocType): string {
  return DOC_TYPE_LABELS[type];
}

export function diffTone(classification: DiffClassification): BadgeTone {
  switch (classification) {
    case "added":
      return "success";
    case "updated":
      return "info";
    case "conflict":
      return "danger";
    case "archived":
      return "warning";
    case "unchanged":
      return "neutral";
  }
}

export function diffLabel(classification: DiffClassification): string {
  switch (classification) {
    case "added":
      return "Novo";
    case "updated":
      return "Actualizado";
    case "conflict":
      return "Conflito";
    case "archived":
      return "Removido";
    case "unchanged":
      return "Sem mudanças";
  }
}

/** Só texto e markdown entram: PDF/OCR devolve 415 no backend (ADR pendente). */
export function mediaTypeFor(file: File): "text/plain" | "text/markdown" | null {
  if (file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt")) {
    return "text/plain";
  }
  if (
    file.type === "text/markdown" ||
    /\.(md|markdown)$/i.test(file.name)
  ) {
    return "text/markdown";
  }
  return null;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("não foi possível ler o ficheiro"));
    reader.readAsDataURL(file);
  });
}
