export function Badge({ variant }: { variant: "running" | "paused" | "finished" }) {
  const variants = {
    running: { bg: "bg-green-100", text: "green-800" },
    paused: { bg: "bg-blue-100", text: "blue-800" },
    finished: { bg: "bg-gray-100", text: "gray-800" },
  };

  const v = variants[variant] || variants.running;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${v.bg} ${v.text}`}
    >
      {variant === "running" ? "Rodando" : variant === "paused" ? "Pausada" : "Finalizada"}
    </span>
  );
}