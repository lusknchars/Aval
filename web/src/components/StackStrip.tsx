import { SiEthereum, SiRust, SiSolana } from 'react-icons/si'
import type { IconType } from 'react-icons'
import SolanaFloat from './SolanaFloat'

/*
 * The technologies behind AVAL, as a row of marks under the verdicts feed.
 * Marks are the official shapes (Simple Icons) in one flat color, unmodified,
 * which the Solana, Ethereum and Rust brand guidelines all allow.
 */
const STACK: { name: string; Icon: IconType }[] = [
  { name: 'Solana', Icon: SiSolana },
  { name: 'Ethereum', Icon: SiEthereum },
  { name: 'Rust', Icon: SiRust },
]

export default function StackStrip() {
  return (
    <div className="stack">
      <p className="kicker stack__label">built with</p>
      <ul className="stack__list">
        {STACK.map(({ name, Icon }) => (
          <li key={name} className="stack__item">
            <Icon className="stack__mark" aria-hidden="true" />
            <span>{name}</span>
          </li>
        ))}
      </ul>
      <SolanaFloat />
    </div>
  )
}
