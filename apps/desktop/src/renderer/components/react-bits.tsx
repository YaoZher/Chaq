import React from "react";

type SpotlightCardProps = React.HTMLAttributes<HTMLElement> & {
  as?: "div" | "form" | "section";
  spotlightColor?: string;
};

export function SpotlightCard({
  as = "div",
  spotlightColor: _spotlightColor,
  className = "",
  style,
  onMouseMove,
  children,
  ...rest
}: SpotlightCardProps): JSX.Element {
  const Element = as;
  return (
    <Element
      className={`surface-card ${className}`.trim()}
      style={style}
      onMouseMove={onMouseMove}
      {...rest}
    >
      {children}
    </Element>
  );
}

export function ShinyText({ children }: {
  children: React.ReactNode;
  disabled?: boolean;
}): JSX.Element {
  return <span>{children}</span>;
}

export function MagneticButton({
  children,
  className = "",
  disabled,
  onMouseMove,
  onMouseLeave,
  style,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      className={className}
      disabled={disabled}
      style={style}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      {...rest}
    >
      {children}
    </button>
  );
}
