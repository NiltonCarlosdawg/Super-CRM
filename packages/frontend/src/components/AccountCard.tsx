import { Badge } from "./Badge";

type AccountCardProps = {
  id: string;
  nome: string;
  status: "online" | "offline" | "limited";
  ultimaMensagem: string;
  mensagensHoje: number;
  limite: number;
  permissoes: string[];
};

export default function AccountCard({
  nome,
  status,
  ultimaMensagem,
  mensagensHoje,
  limite,
  permissoes,
}: AccountCardProps) {
  const statusColor = status === "online"
    ? "bg-green-100 text-green-800"
    : status === "offline"
      ? "bg-gray-100 text-gray-800"
      : "bg-red-100 text-red-800";

  return (
    <div className="bg-card rounded-lg shadow-sm p-5 hover:bg-muted/50 transition-colors cursor-pointer">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-8 h-8 rounded-flex bg-gray-200 flex items-center justify-center flex-shrink-0">
          <svg
            className="w-4 h-4"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M2 3a1 1 0 0 1 1 1h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3zm14 4.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
            <path d="M12 8a4 4 0 0 0-4 4v2a4 4 0 0 0 4 4v2a4 4 0 0 0 4-4v-2a4 4 0 0 0-4-4v-2zm0 0v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2hzm0-2a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
          </svg>
        </div>
        <div>
          <h3 className="font-serif font-medium text-lg">{nome}</h3>
          <span className={`badge ${statusColor} inline rounded-md px-2 py-0.5 text-xs font-medium mt-0.5}`}>{status}</span>
        </div>
      </div>

      <div className="mb-3">
        <div className="text-sm text-muted-foreground">
          <div>Última mensagem:</div>
          <div className="font-medium">{ultimaMensagem}</div>
        </div>
        <div className="flex gap-2 text-xs text-muted-foreground">
          <div>{mensagensHoje} de {limite}</div>
          <div>
            <Badge variant={status === "limited" ? "finished" : "running"} />
          </div>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-border">
        <div className="text-xs text-muted-foreground">
          Permissões:
          {permissoes.map((p, i) => (
            <div
              key={i}
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${i > 0 ? "mx-1" : ""} ${p === "enviar" ? "bg-green-100 text-green-800" : p === "receber" ? "bg-blue-100 text-blue-800" : "gray-200 text-gray-700"}`}
            >
              {p}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}