import { useState } from "react";

type CampaignFormStep = "nome" | "mensagem" | "publico" | "limites" | "schedule";

export function CampaignCreateWizard() {
  const [step, setStep] = useState<CampaignFormStep>("nome");
  const [form, setForm] = useState<{
    nome: string;
    mensagem: string;
    publico: string;
    limiteDiario: number;
    horario: string;
  }>(
    {
      nome: "",
      mensagem: "",
      publico: "",
      limiteDiario: 100,
      horario: "agora",
    }
  );

  const next = () => {
    setStep((s) =>
      s === "schedule"
        ? "nome"
        : s === "nome"
          ? "mensagem"
          : s === "mensagem"
            ? "publico"
            : s === "publico"
              ? "limites"
              : "schedule"
    );
  };

  const prev = () => {
    setStep((s) =>
      s === "nome"
        ? "schedule"
        : s === "schedule"
          ? "limites"
          : s === "limites"
            ? "publico"
            : s === "publico"
              ? "mensagem"
              : "nome"
    );
  };

  const steps = {
    nome: () => (
      <div className="space-y-4">
        <input
          type="text"
          placeholder="Nome da campanha"
          value={form.nome}
          onChange={e => setForm({ ...form, nome: e.target.value })}
          required
          className="input input-bordered w-full"
          aria-label="Nome da campanha"
        />
        <nav className="flex gap-2">
          <button onClick={prev} className="btn btn-outline-small">Anterior</button>
          <button onClick={next} className="btn btn-primary">Próximo</button>
        </nav>
      </div>
    ),
    mensagem: () => (
      <div className="space-y-4">
        <textarea
          placeholder="Mensagem inicial"
          value={form.mensagem}
          onChange={e => setForm({ ...form, mensagem: e.target.value })}
          rows={4}
          required
          className="input input-bordered w-full"
          aria-label="Mensagem inicial"
        />
        <nav className="flex gap-2">
          <button onClick={prev} className="btn btn-outline-small">Anterior</button>
          <button onClick={next} className="btn btn-primary">Próximo</button>
        </nav>
      </div>
    ),
    publico: () => (
      <div className="space-y-4">
        <input
          type="text"
          placeholder="Público/segmento"
          value={form.publico}
          onChange={e => setForm({ ...form, publico: e.target.value })}
          required
          className="input input-bordered w-full"
          aria-label="Público/segmento"
        />
        <nav className="flex gap-2">
          <button onClick={prev} className="btn btn-outline-small">Anterior</button>
          <button onClick={next} className="btn btn-primary">Próximo</button>
        </nav>
      </div>
    ),
    limites: () => (
      <div className="space-y-4">
        <input
          type="number"
          min={1}
          value={form.limiteDiario}
          onChange={e => setForm({ ...form, limiteDiario: Number(e.target.value ) })}
          required
          className="input input-bordered w-full"
          aria-label="Limite diário de mensagens"
        />
        <div className="text-sm text-muted-foreground">
          Limite máximo por dia por conta
        </nav>
        <nav className="flex gap-2">
          <button onClick={prev} className="btn btn-outline-small">Anterior</button>
          <button onClick={next} className="btn btn-primary">Próximo</button>
        </nav>
        ),
        schedule: () => (
          <div className="space-y-4">
            <select
              value={form.horario}
              onChange={e => setForm({ ...form, horario: e.target.value })}
              className="select select-bordered w-full"
              aria-label="Horário de envio"
            >
              <option value="agora">Enviar agora</option>
              <option value="amanha">Enviar amanhã</option>
              <option value="proxima-semana">Na semana que vem</option>
            </select>
            <nav className="flex gap-2">
              <button onClick={prev} className="btn btn-outline-small">Anterior</button>
              <button onClick={next} className="btn btn-primary">Finalizar</button>
            </nav>
          </div>
        ),
      };
      
      return (
        <div className="bg-card rounded-lg shadow-sm p-8">
          <h2 className="font-serif font-medium text-lg mb-6">Criar Nova Campanha</h2>

          <nav className="flex bottom-0 gap-2" role="tablist">
            <button
              onClick={() => setStep("nome")}
              className={step === "nome" ? "bg-primary text-primary-foreground" : "hover:text-primary"}
              aria-selected={step === "nome"}
            >
              1. Nome
            </button>
            <button
              onClick={() => setStep("mensagem")}
              className={step === "mensagem" ? "bg-primary text-primary-foreground" : "hover:text-primary"}
              aria-selected={step === "mensagem"}
            >
              2. Mensagem
            </button>
            <button
              onClick={() => setStep("publico")}
              className={step === "publico" ? "bg-primary text-primary-foreground" : "hover:text-primary"}
              aria-selected={step === "publico"}
            >
              3. Público
            </button>
            <button
              onClick={() => setStep("limites")}
              className={step === "limites" ? "bg-primary text-primary-foreground" : "hover:text-primary"}
              aria-selected={step === "limites"}
            >
              4. Limites
            </button>
            <button
              onClick={() => setStep("schedule")}
              className={step === "schedule" ? "bg-primary text-primary-foreground" : "hover:text-primary"}
              aria-selected={step === "schedule"}
            >
              5. Schedule
            </button>
          </nav>

          <div className="mt-6">{steps[step as CampaignFormStep]()}</div>
        </div>
      );
    }