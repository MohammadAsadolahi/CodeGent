import { render } from 'preact'
import { Header, isReady, Notice, RepoCard, SetupGuide, TaskCard } from './components'
import { History, ReviewCard, RunCard } from './run'
import { useUiState } from './store'
import './styles.css'

const App = () => {
  const state = useUiState()
  if (!state) return <p class="empty">Loading…</p>

  const running = state.run !== null && state.run.state !== 'finished'
  return (
    <>
      <Header connection={state.connection} version={state.version} />
      {state.notice && <Notice notice={state.notice} />}
      <SetupGuide state={state} />
      <RepoCard repo={state.repo} />
      {state.review && <ReviewCard review={state.review} />}
      {state.run && <RunCard run={state.run} />}
      <TaskCard toggles={state.toggles} locked={running} busy={state.busy} />
      {!isReady(state) && !state.run && (
        <p class="muted" style="margin-top:10px">
          You can already write a task. Finish the steps above before you press Start.
        </p>
      )}
      <History items={state.history} />
    </>
  )
}

render(<App />, document.getElementById('root')!)
