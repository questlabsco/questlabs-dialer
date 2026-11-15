export interface AvatarProps {
  /** Full name; initials are derived from it. */
  name: string;
  /** Pixel size. Default 28. */
  size?: number;
  className?: string;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
}

/** Round initials avatar (neutral grey; colours are set in theme.css). */
export function Avatar({ name, size = 28, className }: AvatarProps) {
  return (
    <span
      className={`avatar ${className ?? ''}`.trim()}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) }}
      title={name}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
