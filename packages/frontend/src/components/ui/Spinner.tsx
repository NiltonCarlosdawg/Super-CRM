export function Spinner({ label = "A carregar" }: { label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-block h-4 w-4 animate-spin border-2 border-current border-t-transparent"
    />
  );
}
