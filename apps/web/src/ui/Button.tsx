import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

/** The one button. Primary is reserved for a single action per zone. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, className, children, type = "button", ...rest }, ref,
) {
  const classes = ["g-button", `g-button--${variant}`, `g-button--${size}`, className].filter(Boolean).join(" ");
  return <button ref={ref} type={type} className={classes} {...rest}>
    {icon && <span className="g-button-icon" aria-hidden="true">{icon}</span>}
    {children}
  </button>;
});
