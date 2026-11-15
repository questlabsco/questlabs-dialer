import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Spinner } from './Spinner';

/** primary = brand (solid blue), secondary = neutral (white, grey border, blue text). */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'good' | 'brand' | 'neutral';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Icon rendered before the label. */
  icon?: ReactNode;
  /** Icon rendered after the label (e.g. a chevron). */
  iconEnd?: ReactNode;
  fullWidth?: boolean;
}

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra?: string): string {
  return ['btn', `btn-${variant}`, size !== 'md' ? `btn-${size}` : '', extra ?? ''].filter(Boolean).join(' ');
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, icon, iconEnd, fullWidth, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, [fullWidth ? 'btn-full' : '', className ?? ''].join(' ').trim())}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={size === 'lg' ? 16 : 14} /> : icon}
      {children}
      {iconEnd}
    </button>
  );
});
