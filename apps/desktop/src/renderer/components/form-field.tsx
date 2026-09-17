import React from "react";
import { AlertCircle } from "lucide-react";

export function FormField(props: { label: string; error?: string; hint?: string; className?: string; children: React.ReactNode }): JSX.Element {
  return <label className={["form-field", props.error ? "has-field-error" : "", props.className ?? ""].filter(Boolean).join(" ")}>
    <span className="form-field-label">{props.label}</span>
    {props.children}
    {props.error ? <FieldError message={props.error} /> : props.hint ? <small className="form-field-hint">{props.hint}</small> : null}
  </label>;
}

export function FieldError({ message }: { message?: string }): JSX.Element | null {
  return message ? <small className="field-error" role="alert"><AlertCircle size={13} />{message}</small> : null;
}
