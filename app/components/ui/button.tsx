import * as React from "react";
import { cn } from "@/lib/cn";

type ButtonVariant = "default" | "ghost" | "outline";
type ButtonSize = "default" | "icon";

const BASE_CLASSES =
  "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-full font-body text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  ghost: "bg-transparent text-foreground hover:bg-secondary",
  outline: "border border-border bg-transparent text-foreground hover:bg-secondary",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  default: "h-11 px-6",
  icon: "h-11 w-11",
};

export function buttonVariants({
  variant = "default",
  size = "default",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return cn(BASE_CLASSES, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className);
}

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({ variant, size, className, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonVariants({ variant, size, className })}
      {...props}
    />
  );
}
