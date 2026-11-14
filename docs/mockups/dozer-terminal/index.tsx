import { Caret, Prompt, Stage, Window } from '../../kit'
import './terminal.css'

// dozer README hero, a still. Copied from dark-hero: a dark stage, one
// window inset top and left, off the right and the bottom, depth from surface
// steps on black, one lit color. Here the window is the kit's terminal chrome
// and the one lit color is orange, on the word "awake" only.
//
// Story: `pnpm dev` now runs `dozer next dev`, which prints its ready line;
// `dozer status` shows four checkouts of one repo, one awake, three asleep.
// The eye lands on the STATE / RSS columns: one orange "awake" and one
// memory figure, then a column of "asleep" and dashes.
//
// Real strings: the two commands, the ready line, the status table. Nothing
// else. The table is formatted the way dozer formats it: columns left-aligned,
// two spaces between, header first, awake rows first then asleep, by name.

type Row = { name: string; state: string; port: string; rss: string; last: string }

const ROWS: Row[] = [
  { name: 'shop/web @ main', state: 'awake', port: '3000', rss: '563 MB', last: '12s ago' },
  { name: 'shop/docs @ main', state: 'asleep', port: '3001', rss: '-', last: '1h ago' },
  { name: 'shop/web @ agent-checkout', state: 'asleep', port: '3002', rss: '-', last: '4m ago' },
  { name: 'shop/web @ fix-cart', state: 'asleep', port: '3003', rss: '-', last: 'never' },
]

const HEAD: Row = { name: 'NAME', state: 'STATE', port: 'PORT', rss: 'RSS', last: 'LAST REQUEST' }
const KEYS = ['name', 'state', 'port', 'rss', 'last'] as const
const WIDTH = Object.fromEntries(KEYS.map(k => [k, Math.max(...[HEAD, ...ROWS].map(r => r[k].length))])) as Record<(typeof KEYS)[number], number>

// One table line as dozer prints it: each cell padded to its column, two
// spaces between. Cells are spans only so "awake" can take the accent.
function Line({ row, kind }: { row: Row; kind: 'head' | 'awake' | 'asleep' }) {
  return (
    <div className="dz-tr" data-kind={kind}>
      {KEYS.map((k, i) => {
        const text = i === KEYS.length - 1 ? row[k] : row[k].padEnd(WIDTH[k] + 2)
        return (
          <span key={k} className={`dz-td dz-td--${k}`} data-awake={(k === 'state' && row.state === 'awake') || undefined}>
            {text}
          </span>
        )
      })}
    </div>
  )
}

const PATH = '~/code/shop/web'

export default function DozerTerminal() {
  return (
    <Stage width={1100} height={470} initial={{}} theme="dark" className="dz">
      {() => (
        <Window chrome="terminal" title="shop — zsh" lights="grey" className="dz-win">
          <div className="ss-term dz-term">
            <Prompt path={PATH}>pnpm dev</Prompt>
            <div className="dim">{'> dozer next dev'}</div>
            <div className="dz-ready">dozer listening on http://localhost:3000 (Next.js asleep; starts on first request)</div>
            <Prompt path={PATH}>dozer status</Prompt>
            <div className="dz-table">
              <Line row={HEAD} kind="head" />
              {ROWS.map(r => (
                <Line key={r.name} row={r} kind={r.state === 'awake' ? 'awake' : 'asleep'} />
              ))}
            </div>
            <Prompt path={PATH}>
              <Caret still />
            </Prompt>
          </div>
        </Window>
      )}
    </Stage>
  )
}
