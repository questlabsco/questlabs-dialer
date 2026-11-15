import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { Field, describedBy } from './Field';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  /** Error text; marks the input invalid. */
  error?: ReactNode;
  /** Class on the wrapping .field div. */
  fieldClassName?: string;
  /** Icon inside the input on the left, e.g. <IconSearch />. */
  leadingIcon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, fieldClassName, leadingIcon, id, className, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  const input = (
    <input
      ref={ref}
      id={inputId}
      className={`input ${className ?? ''}`.trim()}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(inputId, hint, error)}
      {...rest}
    />
  );
  return (
    <Field id={inputId} label={label} hint={hint} error={error} className={fieldClassName}>
      {leadingIcon ? (
        <div className="input-wrap">
          <span className="input-icon" aria-hidden="true">
            {leadingIcon}
          </span>
          {input}
        </div>
      ) : (
        input
      )}
    </Field>
  );
});
