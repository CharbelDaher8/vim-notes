/**
 * Inline SVG rather than an icon font or a package: there are a dozen glyphs,
 * they all share one stroke weight, and they need to inherit `currentColor` so
 * the light and dark themes come for free.
 */
import type { SVGProps } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }

function Icon({ size = 16, ...props }: IconProps & { d?: string }) {
  const { d, ...rest } = props
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {d === undefined ? null : <path d={d} />}
    </svg>
  )
}

export const ChevronRight = (props: IconProps) => <Icon {...props} d="M9 6l6 6-6 6" />
export const ChevronDown = (props: IconProps) => <Icon {...props} d="M6 9l6 6 6-6" />
export const Wallet = (props: IconProps) => (
  <Icon
    {...props}
    d="M3 7a2 2 0 0 1 2-2h12v4M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2M3 7h16a2 2 0 0 1 2 2v2h-5a2 2 0 0 0 0 4h5"
  />
)
export const Menu = (props: IconProps) => <Icon {...props} d="M4 7h16M4 12h16M4 17h16" />
export const Plus = (props: IconProps) => <Icon {...props} d="M12 5v14M5 12h14" />
export const Trash = (props: IconProps) => (
  <Icon {...props} d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13M10 11v6M14 11v6" />
)
export const Pencil = (props: IconProps) => (
  <Icon {...props} d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z" />
)
export const Save = (props: IconProps) => (
  <Icon {...props} d="M5 4h11l3 3v13H5V4Zm3 0v6h7V4M8 20v-6h8v6" />
)
export const Sun = (props: IconProps) => (
  <Icon
    {...props}
    d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m11.4 0 1.4 1.4M4.9 4.9l1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"
  />
)
export const Moon = (props: IconProps) => (
  <Icon {...props} d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
)
export const Keyboard = (props: IconProps) => (
  <Icon {...props} d="M3 6h18v12H3V6Zm4 4h.01M11 10h.01M15 10h.01M7 14h10" />
)
export const Warning = (props: IconProps) => (
  <Icon {...props} d="M12 4 2.7 20h18.6L12 4Zm0 6v4m0 3h.01" />
)
export const Close = (props: IconProps) => <Icon {...props} d="M6 6l12 12M18 6 6 18" />
export const Check = (props: IconProps) => <Icon {...props} d="M5 12.5 9.5 17 19 7" />
export const CheckSquare = (props: IconProps) => (
  <Icon {...props} d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11M9 11l3 3 8-8" />
)
export const Bell = (props: IconProps) => (
  <Icon {...props} d="M7 9a5 5 0 0 1 10 0v3.6l1.5 2.9h-13L7 12.6V9Zm3 9a2 2 0 0 0 4 0" />
)
/* Three nodes and the two edges between them -- the smallest thing that reads
   as a graph rather than as three dots. */
export const GraphIcon = (props: IconProps) => (
  <Icon
    {...props}
    d="M7 7.5a2.5 2.5 0 1 0 0-.01M17.5 6a2 2 0 1 0 0-.01M16 18a2.5 2.5 0 1 0 0-.01M9 8.5l5.5 8M9.2 6.6l6.2-1"
  />
)

export const LinkIcon = (props: IconProps) => (
  <Icon
    {...props}
    d="M10.5 13.5a3.8 3.8 0 0 0 5.4 0l2.4-2.4a3.8 3.8 0 0 0-5.4-5.4l-1.3 1.4M13.5 10.5a3.8 3.8 0 0 0-5.4 0l-2.4 2.4a3.8 3.8 0 0 0 5.4 5.4l1.3-1.4"
  />
)

export function FileIcon(props: IconProps) {
  return <Icon {...props} d="M6 3h8l4 4v14H6V3Zm8 0v4h4" />
}

export function FolderIcon({ open = false, ...props }: IconProps & { open?: boolean }) {
  return (
    <Icon
      {...props}
      d={open ? 'M3 8V6h6l2 2h8v2M3 8l-.5 10h17.2L22 10H5.2L3 18' : 'M3 6h6l2 2h10v11H3V6Z'}
    />
  )
}

export function SearchIcon(props: IconProps) {
  return <Icon {...props} d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 4.5 4.5" />
}
