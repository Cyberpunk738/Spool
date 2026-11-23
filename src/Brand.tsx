import { HOME_URL } from './navigation'

export default function Brand() {
  return (
    <a className="brand" href={HOME_URL} aria-label="Spool home">
      <span className="brand-mark">
        <span />
      </span>
      <span>spool</span>
    </a>
  )
}
