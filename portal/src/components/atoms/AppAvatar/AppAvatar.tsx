import type { CSSProperties } from 'react'

interface AppAvatarProps {
  name: string
  size?: number
}

/** A stable hue per name, so an app keeps its colour everywhere it appears. */
function avatarHue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return h
}

export default function AppAvatar({ name, size = 36 }: AppAvatarProps) {
  const style = {
    width: size,
    height: size,
    '--avatar-hue': String(avatarHue(name)),
  } as CSSProperties

  return (
    <span className="avatar" style={style} aria-hidden="true">
      {name.charAt(0).toUpperCase()}
    </span>
  )
}
