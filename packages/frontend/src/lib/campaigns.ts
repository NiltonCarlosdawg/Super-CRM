// Transições permitidas pela API de campanhas (Fase 4): o backend recusa
// qualquer outra combinação com 409. A UI usa isto só para mostrar ou esconder
// acções; a autoridade continua a ser o servidor.

import type { BadgeTone } from "../components/ui/Badge";
import type { CampaignPauseReason, CampaignStatus } from "./types";

export function canStart(status: CampaignStatus): boolean {
  return status === "draft";
}

export function canPause(status: CampaignStatus): boolean {
  return status === "running" || status === "scheduled";
}

export function canResume(status: CampaignStatus): boolean {
  return status === "paused";
}

export function campaignTone(status: CampaignStatus): BadgeTone {
  switch (status) {
    case "running":
      return "success";
    case "scheduled":
      return "info";
    case "paused":
      return "warning";
    case "cancelled":
      return "danger";
    case "draft":
    case "completed":
      return "neutral";
  }
}

const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Rascunho",
  scheduled: "Agendada",
  running: "A correr",
  paused: "Pausada",
  completed: "Concluída",
  cancelled: "Cancelada",
};

export function campaignStatusLabel(status: CampaignStatus): string {
  return CAMPAIGN_STATUS_LABELS[status];
}

const PAUSE_REASON_LABELS: Record<CampaignPauseReason, string> = {
  failure_rate: "Taxa de falhas elevada",
  session_down: "Sessão em baixo",
  opt_out_spike: "Pico de opt-outs",
  human: "Pausada por um humano",
};

export function campaignPauseReasonLabel(reason: CampaignPauseReason): string {
  return PAUSE_REASON_LABELS[reason];
}
