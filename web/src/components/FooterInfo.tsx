import { SiGithub, SiSolana } from 'react-icons/si'

/*
 * The left side of the footer screen: who it is built for, what it runs on,
 * the numbers from the speed section, and the team. Avatars come straight
 * from each GitHub profile.
 */
const STATS = [
  { n: '0.39 ms', l: 'verdict, warm p50' },
  { n: '574×', l: 'faster than RPC simulate' },
  { n: '10', l: 'attack patterns stopped' },
]

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

      <dl className="finfo__stats">
        {STATS.map((s) => (
          <div key={s.l}><dt>{s.n}</dt><dd>{s.l}</dd></div>
        ))}
      </dl>

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
