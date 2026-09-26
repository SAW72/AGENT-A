export function ErrorNotice({
  main,
  detail,
  link,
}: {
  main: string
  detail?: string | null
  link?: { href: string; label: string } | null
}) {
  return (
    <div className="error-notice" role="alert">
      <p className="error-notice-main">{main}</p>
      {link ? (
        <p className="error-notice-detail">
          <a href={link.href}>{link.label}</a>
        </p>
      ) : null}
      {detail ? <p className="error-notice-detail">{detail}</p> : null}
    </div>
  )
}
