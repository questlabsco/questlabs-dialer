import type { HTMLAttributes } from 'react';

export type Tone = 'neutral' | 'accent' | 'good' | 'warning' | 'critical';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Leading coloured dot (for statuses). */
  dot?: boolean;
  /** Default 'md'. */
  size?: 'sm' | 'md' | 'lg';
  /** Outlined instead of a tinted fill. */
  outline?: boolean;
}

/** Status pill: soft tinted background, optional dot. One tone mapping app-wide. */
export function Badge({ tone = 'neutral', dot, size = 'md', outline, className, children, ...rest }: BadgeProps) {
  const cls = [
    'badge',
    tone !== 'neutral' ? `badge-${tone}` : '',
    dot ? 'badge-dot' : '',
    size !== 'md' ? `badge-${size}` : '',
    outline ? 'badge-outline' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}
