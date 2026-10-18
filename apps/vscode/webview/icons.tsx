import type { JSX } from 'preact'

type IconProps = { size?: number; class?: string }

const Svg = ({
  size = 14,
  class: className,
  children
}: IconProps & { children: JSX.Element | JSX.Element[] }) => (
  <svg
    class={`icon ${className ?? ''}`}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

export const Check = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5 6.3 12 13 4.5" />
  </Svg>
)
export const Cross = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
)
export const Warn = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.2 14.2 13H1.8L8 2.2Z" />
    <path d="M8 6.5v3.2M8 11.4v.1" />
  </Svg>
)
export const Info = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.2v4M8 4.8v.1" />
  </Svg>
)
export const Play = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 3v10L13 8 4.5 3Z" fill="currentColor" />
  </Svg>
)
export const Stop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.2" fill="currentColor" />
  </Svg>
)
export const Undo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.5 3 6.5l3 3" />
    <path d="M3.4 6.5H9a3.6 3.6 0 0 1 0 7.2H6" />
  </Svg>
)
export const Folder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2v-7.6Z" />
  </Svg>
)
export const Copy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.3" />
    <path d="M10.5 5.5V3.8c0-.7-.5-1.3-1.3-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.4c0 .8.6 1.3 1.3 1.3h1.7" />
  </Svg>
)
export const Refresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.2 8A5.2 5.2 0 1 1 11.6 4.3" />
    <path d="M13.5 2.5v3h-3" />
  </Svg>
)
export const Diff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 2.5v7M1.5 6h7" />
    <path d="M9.5 12.5h5" />
    <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
  </Svg>
)
export const External = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
    <path d="M12 9v3.2c0 .7-.5 1.3-1.3 1.3H3.8c-.7 0-1.3-.6-1.3-1.3V5.3c0-.8.6-1.3 1.3-1.3H7" />
  </Svg>
)
export const Spinner = (p: IconProps) => (
  <Svg {...p} class={`spin ${p.class ?? ''}`}>
    <path d="M8 1.8a6.2 6.2 0 1 1-6.2 6.2" />
  </Svg>
)
export const Dot = ({ size = 8, class: className }: IconProps) => (
  <svg
    class={`dot ${className ?? ''}`}
    width={size}
    height={size}
    viewBox="0 0 8 8"
    aria-hidden="true"
  >
    <circle cx="4" cy="4" r="4" fill="currentColor" />
  </svg>
)
