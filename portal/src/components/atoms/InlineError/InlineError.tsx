interface InlineErrorProps {
  /** Renders nothing when empty, so it can sit in a layout unconditionally. */
  message: string | undefined
}

export default function InlineError({ message }: InlineErrorProps) {
  if (!message) return null

  return (
    <div className="inline-error" role="alert">
      {message}
    </div>
  )
}
