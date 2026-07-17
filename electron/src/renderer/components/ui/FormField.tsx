import type { HTMLAttributes, ReactNode } from 'react';

export interface FormFieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
}

/** Label + control + optional hint/error row for settings and wizards. */
export function FormField({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  children,
  className = '',
  ...props
}: FormFieldProps) {
  const describedBy = error ? `${htmlFor ?? 'field'}-error` : hint ? `${htmlFor ?? 'field'}-hint` : undefined;

  return (
    <div className={`orchid-form-field flex flex-col gap-1 ${className}`.trim()} {...props}>
      <label className="label py-0" htmlFor={htmlFor}>
        <span className="label-text">
          {label}
          {required && (
            <span className="text-error" aria-hidden>
              {' '}
              *
            </span>
          )}
        </span>
      </label>
      <div
        className="orchid-form-field-control"
        // Consumers wire aria-describedby on the control when needed.
        data-described-by={describedBy}
      >
        {children}
      </div>
      {error != null && error !== false ? (
        <p id={describedBy} className="label py-0 text-error" role="alert">
          {error}
        </p>
      ) : hint != null && hint !== false ? (
        <p id={describedBy} className="label py-0 text-base-content/60">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
