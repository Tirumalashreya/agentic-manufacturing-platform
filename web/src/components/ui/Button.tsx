import Link from "next/link";
import { cn } from "@/lib/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "onBrand" | "ghostOnBrand" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-500 text-white hover:bg-brand-600 shadow-sm shadow-brand-500/20",
  secondary:
    "bg-surface-muted text-foreground border border-border hover:bg-surface",
  ghost: "text-foreground hover:bg-surface-muted",
  // For use on top of a brand-colored background (e.g. the CTA band) — kept as
  // dedicated variants rather than className overrides, since Tailwind's utility
  // ordering in the generated stylesheet doesn't follow className string order
  // and a naive override can silently lose (e.g. text-white beating text-brand-700).
  onBrand: "bg-white text-brand-700 hover:bg-brand-50",
  ghostOnBrand: "text-white hover:bg-white/10",
  danger: "bg-red-600 text-white hover:bg-red-700 shadow-sm shadow-red-600/20",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-5 text-sm",
  lg: "h-12 px-6 text-base",
};

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500";

type ButtonAsButton = {
  href?: undefined;
  variant?: ButtonVariant;
  size?: ButtonSize;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

type ButtonAsLink = {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

export function Button(props: ButtonAsButton | ButtonAsLink) {
  const { variant = "primary", size = "md", className, ...rest } = props;
  const classes = cn(base, variantClasses[variant], sizeClasses[size], className);

  if (rest.href) {
    const { href, children, ...anchorRest } = rest as ButtonAsLink;
    return (
      <Link href={href} className={classes} {...anchorRest}>
        {children}
      </Link>
    );
  }

  const { children, ...buttonRest } = rest as ButtonAsButton;
  return (
    <button className={classes} {...buttonRest}>
      {children}
    </button>
  );
}
