import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked'> {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
}

export function Checkbox({ label, checked, onChange, hint, id, className, ...rest }: CheckboxProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <label className={`checkbox ${className ?? ''}`.trim()} htmlFor={inputId}>
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint ? `${inputId}-hint` : undefined}
        {...rest}
      />
      <span>
        {label}
        {hint && (
          <span className="field-hint" id={`${inputId}-hint`}>
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}
