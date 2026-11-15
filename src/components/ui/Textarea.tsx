import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Field, describedBy } from './Field';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  fieldClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, fieldClassName, id, className, rows = 3, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field id={inputId} label={label} hint={hint} error={error} className={fieldClassName}>
      <textarea
        ref={ref}
        id={inputId}
        rows={rows}
        className={`textarea ${className ?? ''}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, hint, error)}
        {...rest}
      />
    </Field>
  );
});
