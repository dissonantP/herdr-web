import type { ReactNode } from "react";

// Stroke icons for the composer buttons: one weight and size, coloured by the button's text colour.
const icon = (path: ReactNode) => (
  <svg className="composer-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

export const PlusIcon = () => icon(<path d="M12 5v14M5 12h14" />);
export const SendIcon = () => icon(<path d="M12 19V5M5 12l7-7 7 7" />);
export const CloseIcon = () => icon(<path d="M6 6l12 12M18 6L6 18" />);
export const MicIcon = () =>
  icon(
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>,
  );
export const StopIcon = () => (
  <svg className="composer-icon" viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);
