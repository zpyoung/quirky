const SECTION = 'sidebar-section:quirky.worktree/worktrees'
const SESSION_VIEW = 'view:quirky.session/worktree'

/** Replaces the worktree sidebar section with one flat list of every worktree. */
export function activate(context) {
  context.provide(SECTION, (element, props) => {
    const list = document.createElement('ul')
    list.className = 'sample-flat-worktrees'
    element.append(list)

    let worktrees = []
    let stopped = false
    let latest = 0

    const render = () => {
      list.replaceChildren(
        ...worktrees.map((worktree) => {
          const item = document.createElement('li')
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = worktree.name
          button.dataset.worktree = worktree.id
          button.addEventListener('click', () => context.openView(SESSION_VIEW, { worktree: worktree.id }))
          item.append(button)
          return item
        })
      )
      props.report?.({ flat: true, worktrees: worktrees.map(({ id, name }) => ({ id, name })) })
    }

    const load = async () => {
      const ticket = ++latest
      try {
        const next = await context.call('quirky.worktree/list')
        if (stopped || ticket !== latest) return
        worktrees = next
        render()
      } catch (error) {
        context.log(`could not load worktrees: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.worktree/changed' || event.type === 'quirky.repo/changed') void load()
    })
    const stopConnection = context.onConnection((status) => {
      if (status === 'connected') void load()
    })
    void load()

    return () => {
      stopped = true
      unsubscribe()
      stopConnection()
    }
  })
}

export function deactivate() {}
