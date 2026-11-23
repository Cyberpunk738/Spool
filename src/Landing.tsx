import { ArrowUpRight, Download, Film, ShieldCheck } from 'lucide-react'
import Brand from './Brand'
import { STUDIO_URL } from './navigation'

export default function Landing() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
      </header>

      <main>
        <section className="hero">
          <div className="eyebrow">
            <span /> A little less editing. A lot more creating.
          </div>
          <h1>
            Good stories.
            <br />
            <em>Beautifully cut.</em>
          </h1>
          <p>
            Turn the moments on your device into something worth sharing.
            <br className="desktop-break" /> Trim, arrange, add your soundtrack. Keep it all yours.
          </p>
          <a className="primary-button hero-cta" href={STUDIO_URL}>
            Open Studio <ArrowUpRight size={17} />
          </a>
          <div className="hero-notes">
            <span>
              <ShieldCheck size={14} /> Private by design
            </span>
            <span>
              <Film size={14} /> No sign-up needed
            </span>
            <span>
              <Download size={14} /> Export to MP4
            </span>
          </div>
        </section>

        <section className="why-spool" aria-label="Why Spool">
          <div className="why-intro">
            <h2>
              Less between you
              <br />
              and <span>your next idea.</span>
            </h2>
            <p>A focused little studio. Everything you need to make a short video feel like you.</p>
          </div>
          <div className="benefit-card">
            <ShieldCheck size={24} />
            <strong>
              100%<span>yours.</span>
            </strong>
            <p>Your files stay on your device. From the first import to the final frame.</p>
          </div>
          <div className="benefit-card mint">
            <Film size={24} />
            <strong>
              One story.<span>Any canvas.</span>
            </strong>
            <p>Landscape, portrait or square. Ready for wherever your story goes next.</p>
          </div>
        </section>
      </main>

      <footer>
        <Brand />
        <span>Small edits. Lasting moments.</span>
        <a href={STUDIO_URL}>Open Studio ↗</a>
      </footer>
    </div>
  )
}
