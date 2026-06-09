import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Glass({
  children,
  pad = true,
  className = "",
}: {
  children: ReactNode;
  pad?: boolean;
  className?: string;
}) {
  return <div className={`glass ${pad ? "glass-pad" : ""} ${className}`}>{children}</div>;
}

export function Button({
  variant = "primary",
  loading = false,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost";
  loading?: boolean;
}) {
  return (
    <button
      className={`btn btn-${variant}`}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading ? <span className="spin" /> : children}
    </button>
  );
}

export function Field({
  label,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <label style={{ display: "block" }}>
      {label && <span className="label">{label}</span>}
      <input className="field" {...rest} />
    </label>
  );
}

export function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="steps">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`step-dot ${i < current ? "done" : i === current ? "active" : ""}`}
        />
      ))}
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return <div className="avatar">{initials || "?"}</div>;
}

export function Spinner() {
  return (
    <div className="center" style={{ padding: 40 }}>
      <span className="spin" style={{ margin: "0 auto" }} />
    </div>
  );
}

export function StatusDot({ status }: { status: string }) {
  return <span className={`dot ${status}`} />;
}
