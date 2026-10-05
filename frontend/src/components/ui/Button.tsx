import type { ButtonHTMLAttributes, ReactNode } from "react";
import Link from "next/link";

type Variant = "primary" | "secondary";

// Wraps the existing .btn/.btn.secondary classes (globals.css) — same
// variant-naming convention as web/'s (APS Platform) Button component,
// for cross-app consistency (design-system pass, agreed with the user).
type CommonProps = { variant?: Variant; children: ReactNode; className?: string };

type ButtonProps = CommonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };
type LinkProps = CommonProps & { href: string };

export function Button(props: ButtonProps | LinkProps) {
  const { variant = "primary", children, className, ...rest } = props;
  const cls = `btn${variant === "secondary" ? " secondary" : ""}${className ? ` ${className}` : ""}`;

  if ("href" in props && props.href) {
    return (
      <Link href={props.href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button className={cls} {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  );
}
