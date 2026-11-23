import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Landing from './Landing'
import { HOME_URL, STUDIO_URL } from './navigation'
import './styles.css'

if (
  window.location.pathname === STUDIO_URL.slice(0, -1) ||
  (window.location.pathname === HOME_URL && window.location.hash === '#studio')
) {
  window.location.replace(STUDIO_URL + window.location.search)
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Landing />
    </StrictMode>,
  )
}
