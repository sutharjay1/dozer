import { Stage } from '../../kit'
import './memory.css'

// dozer README before/after, a still. Copied from static-card: a light well
// that is its own ground (so the PNG reads on white and on GitHub dark), quiet
// white cards with a hairline and the hero shadow, real words only on what the
// story is about. Changed: one card split into two columns instead of a
// window and a satellite, since the story is a comparison, and the content is
// memory bars, not a customer list.
//
// Story: the same three worktrees, run two ways. Left, plain `next dev` in
// each: three awake servers. Right, `dozer next dev` in each: the one you are
// using is awake, the other two are asleep (dozer's own process), plus the
// machine-wide coordinator. The eye goes from the long bars to the short ones,
// then to the one orange figure: what dozer saves.
//
// Numbers (MiB, measured RSS on a small Next.js 16 test app; nothing else):
// awake Next.js server 563, asleep app (dozer's process) 47, coordinator 45.
// The provenance line goes under the image in the README (a caption), not in
// it: a footnote inside the well broke the one-gutter frame. Suggested text:
// "Measured RSS on a small Next.js 16 test app. An asleep app is dozer's own
// process; bigger apps use far more per awake server."

const AWAKE = 563
const ASLEEP = 47
const COORDINATOR = 45

type Server = { name: string; state: 'awake' | 'asleep'; mib: number }

const TREES = ['shop/web @ main', 'shop/web @ fix-cart', 'shop/web @ agent-checkout']

const BEFORE: Server[] = TREES.map(name => ({ name, state: 'awake', mib: AWAKE }))
const AFTER: Server[] = TREES.map((name, i) => ({ name, state: i === 0 ? 'awake' : 'asleep', mib: i === 0 ? AWAKE : ASLEEP }))

const sum = (s: Server[]) => s.reduce((t, x) => t + x.mib, 0)
const BEFORE_TOTAL = sum(BEFORE) // 1,689
const AFTER_TOTAL = sum(AFTER) + COORDINATOR // 702
const SAVED = BEFORE_TOTAL - AFTER_TOTAL // 987

const mib = (n: number) => `${n.toLocaleString('en-US')} MiB`

function Panel({ command, note, servers, total, extra, saved }: { command: string; note: string; servers: Server[]; total: number; extra?: string; saved?: number }) {
  return (
    <div className="dm-card">
      <div className="dm-head">
        <span className="dm-cmd">{command}</span>
        <span className="dm-note">{note}</span>
      </div>
      <div className="dm-rows">
        {servers.map(s => (
          <div key={s.name} className="dm-row" data-state={s.state}>
            <div className="dm-line">
              <span className="dm-name">{s.name}</span>
              <span className="dm-state">{s.state}</span>
              <span className="dm-val">{mib(s.mib)}</span>
            </div>
            <div className="dm-track">
              <div className="dm-bar" style={{ width: `${(s.mib / AWAKE) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="dm-total">
        <span className="dm-total__label">
          Total
          {extra && <span className="dm-total__extra">{extra}</span>}
        </span>
        <span className="dm-total__val">
          {saved !== undefined && <span className="dm-saved">−{mib(saved)}</span>}
          {mib(total)}
        </span>
      </div>
    </div>
  )
}

export default function DozerMemory() {
  return (
    <Stage width={1100} height={345} initial={{}} className="dm">
      {() => (
        <div className="dm-pair">
          <Panel command="next dev ×3" note="3 servers awake" servers={BEFORE} total={BEFORE_TOTAL} />
          <Panel command="dozer next dev ×3" note="1 awake, 2 asleep" servers={AFTER} total={AFTER_TOTAL} extra={`incl. coordinator ${COORDINATOR} MiB`} saved={SAVED} />
        </div>
      )}
    </Stage>
  )
}
