import { useId } from 'react';

export interface LogoProps {
  /** Pixel height; width follows the mark's aspect ratio. Default 24. */
  size?: number;
  /**
   * 'color': dark ring for light backgrounds (default).
   * 'reversed': white ring for dark backgrounds (sidebar, dark panels).
   * Both keep the blue-to-violet bar.
   */
  variant?: 'color' | 'reversed';
  /** Accessible name; when omitted the logo is decorative. */
  title?: string;
  className?: string;
}

/** The Quest Labs "Q" mark: ring plus two slanted bars (vector redraw of build/logo-source.png). */
export function Logo({ size = 24, variant = 'color', title, className }: LogoProps) {
  const uid = useId().replace(/:/g, '');
  const ink = variant === 'reversed' ? '#FFFFFF' : '#141821';
  const width = Math.round((size * 532) / 468);
  return (
    <svg
      className={`brand-logo ${className ?? ''}`.trim()}
      width={width}
      height={size}
      viewBox="84 88 532 468"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      <defs>
        <linearGradient id={`${uid}-g`} gradientUnits="userSpaceOnUse" x1="410" y1="396" x2="606" y2="528">
          <stop offset="0" stopColor="#2D3BFF" />
          <stop offset="1" stopColor="#7C3AED" />
        </linearGradient>
        <mask id={`${uid}-m`} maskUnits="userSpaceOnUse" x="0" y="0" width="712" height="622">
          <rect x="0" y="0" width="712" height="622" fill="#fff" />
          <polygon points="162,300 410,300 701,600 453,600" fill="#000" />
        </mask>
      </defs>
      <circle cx="318" cy="322" r="197" fill="none" stroke={ink} strokeWidth="56" mask={`url(#${uid}-m)`} />
      <polygon points="250,365 321,365 479,528 408,528" fill={ink} />
      <polygon points="410,396 478,396 606,528 538,528" fill={`url(#${uid}-g)`} />
    </svg>
  );
}
