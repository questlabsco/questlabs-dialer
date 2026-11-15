export interface SpinnerProps {
  /** Pixel size. Default 18. */
  size?: number;
  /** Accessible label; when omitted the spinner is decorative. */
  label?: string;
}

export function Spinner({ size = 18, label }: SpinnerProps) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
