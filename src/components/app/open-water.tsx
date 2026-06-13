import { forwardRef } from "react";

export function OpenWaterBackground() {
  return (
    <svg
      aria-hidden="true"
      className="openWaterBackground"
      preserveAspectRatio="none"
      viewBox="0 0 580 1600"
    >
      <path d="M0 250 Q 145 205 290 250 T 580 250 V1600 H0 Z" fill="#F1F3F6" />
      <path d="M0 680 Q 145 635 290 680 T 580 680 V1600 H0 Z" fill="#EDEFF3" />
      <path d="M0 1120 Q 145 1075 290 1120 T 580 1120 V1600 H0 Z" fill="#E9EBF0" />
      <path
        d="M0 250 Q 145 205 290 250 T 580 250"
        fill="none"
        stroke="#E4E6EB"
        strokeWidth="1"
      />
      <path
        d="M0 680 Q 145 635 290 680 T 580 680"
        fill="none"
        stroke="#E0E3E9"
        strokeWidth="1"
      />
      <path
        d="M0 1120 Q 145 1075 290 1120 T 580 1120"
        fill="none"
        stroke="#DCDFE6"
        strokeWidth="1"
      />
    </svg>
  );
}

export function OpenWaterHeroWaves() {
  return (
    <svg
      viewBox="0 0 580 60"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="openWaterHeroWaves"
    >
      <path d="M0 22 Q 72 10 145 22 T 290 22 T 435 22 T 580 22 V60 H0 Z" fill="#173A93" />
      <path d="M0 40 Q 72 29 145 40 T 290 40 T 435 40 T 580 40 V60 H0 Z" fill="#112F78" />
    </svg>
  );
}

export function OpenWaterHeroRings() {
  return (
    <svg
      width="108"
      height="82"
      viewBox="0 0 108 82"
      aria-hidden="true"
      className="openWaterHeroRings"
    >
      <circle
        cx="60"
        cy="40"
        r="12"
        fill="none"
        stroke="rgba(255,255,255,0.26)"
        strokeWidth="1.3"
      />
      <circle
        cx="60"
        cy="40"
        r="22"
        fill="none"
        stroke="rgba(255,255,255,0.17)"
        strokeWidth="1.3"
      />
      <circle
        cx="60"
        cy="40"
        r="32"
        fill="none"
        stroke="rgba(255,255,255,0.10)"
        strokeWidth="1.3"
      />
    </svg>
  );
}

export function OpenWaterLogoMark({ className }: { className?: string }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 42 42"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M21 8 C29 8 34 14 34 21 C34 29 27 34 20 34 C13 34 9 29 9 23 C9 17 13 13 19 13 C24 13 27 17 27 21 C27 25 24 28 20 28 C17 28 15 26 15 23"
        fill="none"
        stroke="#1C44A8"
        strokeWidth="2.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

type PressVariant = "blue" | "green" | "white" | "again" | "hero" | "ghost";

interface PressButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: PressVariant;
}

export const PressButton = forwardRef<HTMLButtonElement, PressButtonProps>(
  ({ variant = "blue", className = "", style, type = "button", ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={`bpbtn bpbtn-${variant} ${className}`}
      style={style}
      {...rest}
    />
  ),
);
PressButton.displayName = "PressButton";
