interface FieldErrorProps {
  message: string | undefined
}

/** Validation message under a form field. Renders nothing when there is none. */
export default function FieldError({ message }: FieldErrorProps) {
  return message ? <div className="field-error">{message}</div> : null
}
