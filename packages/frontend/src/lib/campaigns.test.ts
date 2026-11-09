import { describe, expect, it } from "vitest";
import {
  campaignPauseReasonLabel,
  campaignStatusLabel,
  campaignTone,
  canPause,
  canResume,
  canStart,
} from "./campaigns";

describe("transições de campanha", () => {
  it("só rascunho inicia", () => {
    expect(canStart("draft")).toBe(true);
    for (const status of ["scheduled", "running", "paused", "completed", "cancelled"] as const) {
      expect(canStart(status)).toBe(false);
    }
  });

  it("só a correr/agendada pausa", () => {
    expect(canPause("running")).toBe(true);
    expect(canPause("scheduled")).toBe(true);
    expect(canPause("draft")).toBe(false);
    expect(canPause("paused")).toBe(false);
    expect(canPause("completed")).toBe(false);
  });

  it("só pausada retoma", () => {
    expect(canResume("paused")).toBe(true);
    expect(canResume("running")).toBe(false);
  });

  it("rótulos e tons cobrem os seis estados", () => {
    expect(campaignStatusLabel("draft")).toBe("Rascunho");
    expect(campaignStatusLabel("running")).toBe("A correr");
    expect(campaignStatusLabel("paused")).toBe("Pausada");
    expect(campaignTone("running")).toBe("success");
    expect(campaignTone("paused")).toBe("warning");
    expect(campaignTone("draft")).toBe("neutral");
    expect(campaignPauseReasonLabel("human")).toBe("Pausada por um humano");
    expect(campaignPauseReasonLabel("session_down")).toBe("Sessão em baixo");
  });
});
