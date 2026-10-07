import { SiGithub, SiSolana } from 'react-icons/si'

/*
 * The left side of the footer screen: who it is built for, what it runs on,
 * the promise in one line, and the team. Avatars come straight
 * from each GitHub profile.
 */
const TEAM = ['lusknchars', 'ericferrazp', 'Luispessoa18']

export default function FooterInfo() {
  return (
    <div className="finfo">
      <div className="finfo__partners">
        <p className="finfo__label">Built for</p>
        <img className="finfo__st" src="/brand/superteam-brasil-white.svg" alt="Superteam Brasil" width={496} height={79} />
        <p className="finfo__label">Runs on</p>
        <span className="finfo__sol"><SiSolana aria-hidden="true" /> Solana mainnet</span>
      </div>

      <div className="finfo__slogan">
        <p className="finfo__line">Every transaction judged before it lands.</p>
        <p className="finfo__line finfo__line--dim">Every agent watched, 24/7.</p>
        <p className="finfo__live"><i aria-hidden="true" /> monitoring live · simulated before signing · vetoed in under a millisecond</p>
      </div>

      <div className="finfo__team">
        <p className="finfo__label">The team</p>
        <ul>
          {TEAM.map((h) => (
            <li key={h}>
              <a href={`https://github.com/${h}`} target="_blank" rel="noreferrer">
                <img src={`https://github.com/${h}.png?size=96`} alt="" width={36} height={36} loading="lazy" />
                <span>@{h}</span>
                <SiGithub aria-hidden="true" className="finfo__gh" />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
