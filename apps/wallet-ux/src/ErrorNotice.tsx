export function ErrorNotice({ main, detail }: { main: string; detail?: string | null }) {
  return (
    <div className="error-notice" role="alert">
      <p className="error-notice-main">{main}</p>
      {detail ? <p className="error-notice-detail">{detail}</p> : null}
    </div>
  )
}
