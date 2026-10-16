import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "solid" | "outline" | "ghost";
  children?: ReactNode;
}

const VARIANTS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  solid: "bg-accent text-white hover:bg-accent-hover",
  outline: "border border-accent text-accent hover:bg-accent-soft",
  ghost: "text-muted hover:bg-accent-soft hover:text-fg",
};

const BASE =
  "inline-flex items-center justify-center gap-2 px-4 py-2 text-sm transition-colors disabled:pointer-events-none disabled:opacity-50";

export function Button({ variant = "solid", type, className = "", children, ...rest }: ButtonProps) {
  return (
    <button type={type ?? "button"} className={`${BASE} ${VARIANTS[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}
