import type { SVGProps } from "react";

type MotroLogoProps = SVGProps<SVGSVGElement> & {
  /**
   * The compact variant keeps the open-ended track geometry but uses a
   * slightly heavier stroke at very small sizes.
   */
  compact?: boolean;
};

/**
 * Motro's "Learning Track M" mark.
 *
 * Four open terminals form the selected "Track M": two outer vertical rails
 * and two inward diagonals that meet across the center without closing the
 * silhouette. It intentionally inherits `currentColor` so the mark
 * participates in the surrounding semantic color system.
 */
export function MotroLogo({ compact = false, ...props }: MotroLogoProps) {
  return (
    <svg viewBox="0 0 48 32" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M6 28V4L30 24"
        stroke="currentColor"
        strokeWidth={compact ? "7" : "6.5"}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M42 28V4L18 24"
        stroke="currentColor"
        strokeWidth={compact ? "7" : "6.5"}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
