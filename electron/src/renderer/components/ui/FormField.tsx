import {
  cloneElement,
  isValidElement,
  useId,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';

export interface FormFieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode;
  /**
   * Associates the label with the control. Pass the same value as the control's `id`
   * when the control is a single element; if omitted, a unique id is generated and injected.
   */
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
}

type ControlProps = {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
};

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
  const autoId = useId();
  const childProps = isValidElement(children)
    ? (children.props as ControlProps)
    : undefined;
  const fieldId = htmlFor ?? childProps?.id ?? autoId;
  const hintId = `${autoId}-hint`;
  const errorId = `${autoId}-error`;
  const hasError = error != null && error !== false;
  const hasHint = hint != null && hint !== false;
  const describedBy = hasError ? errorId : hasHint ? hintId : undefined;

  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<ControlProps>, {
        id: childProps?.id ?? fieldId,
        ...(describedBy
          ? {
              'aria-describedby': [childProps?.['aria-describedby'], describedBy]
                .filter(Boolean)
                .join(' '),
            }
          : {}),
        ...(hasError ? { 'aria-invalid': true as const } : {}),
      })
    : children;

  return (
    <div className={`orchid-form-field flex flex-col gap-1 ${className}`.trim()} {...props}>
      <label className="label py-0" htmlFor={fieldId}>
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
      <div className="orchid-form-field-control">{control}</div>
      {hasError ? (
        <p id={errorId} className="label py-0 text-error" role="alert">
          {error}
        </p>
      ) : hasHint ? (
        <p id={hintId} className="label py-0 text-base-content/60">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
