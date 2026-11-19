import { FEATURES, STATS, STEPS } from './content.ts';

/**
 * F-01 landing page · F-02 explainer cards · F-03 the absent badge.
 *
 * F-03 has no component on purpose: the "Edit with" overlay was a Base44
 * artifact, so the rebuilt bundle must contain nothing that could render it.
 * T-03 asserts its absence in the shipped assets.
 */
export function Landing() {
  return (
    <div className="landing">
      <main>
        <div className="hero-block">
          <header className="landing-nav">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true" />
          HostSync
        </a>
        <nav className="landing-nav-actions" aria-label="Account">
          <a className="btn btn-ghost" href="/login">
            Sign in
          </a>
          <a className="btn btn-primary" href="/register">
            Create account
          </a>
        </nav>
        </header>

        <section className="hero">
          <p className="eyebrow">Property operations for short lets</p>
          <h1>Add your property. <em>We hold every night.</em></h1>
          <p className="hero-sub">
            One calendar for every channel, one ledger for every stay, and a database that refuses to
            let two guests book the same night. Built for hosts who are done reconciling spreadsheets
            by hand.
          </p>
          <div className="hero-cta">
            <a className="btn btn-primary btn-lg" href="/register">
              Create account
            </a>
            <a className="btn btn-lg" href="/login">
              Sign in
            </a>
          </div>
          <p className="hero-note">No card, no trial timer. Your data stays yours.</p>

          <ul className="stats" aria-label="What the grid guarantees">
            {STATS.map((stat) => (
              <li key={stat.value}>
                <strong>{stat.value}</strong>
                <span>{stat.label}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

        <section className="steps" aria-labelledby="steps-title">
          <h2 id="steps-title">Three steps to a week that holds</h2>
          <ol>
            {STEPS.map((step, index) => (
              <li key={step.title} data-step={index + 1}>
                <span className="step-number" aria-hidden="true">
                  {index + 1}
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="features" id="features" aria-labelledby="features-title">
          <h2 id="features-title">Everything a stay touches</h2>
          <p className="section-sub">
            Eight parts of the job that are usually spread across a spreadsheet, a phone and three
            channel dashboards.
          </p>
          <div className="feature-grid">
            {FEATURES.map((feature) => (
              <article className="feature-card" key={feature.id} data-feature={feature.id}>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="closing">
          <h2>Start with one property</h2>
          <p>Add a rate, a cleaning fee and an owner. The rest fills in as stays arrive.</p>
          <a className="btn btn-primary btn-lg" href="/register">
            Create account
          </a>
        </section>
      </main>

      <footer className="landing-foot">
        <span>HostSync — one calendar that holds.</span>
        <span>Built with our own auth, database and money rules.</span>
      </footer>
    </div>
  );
}
