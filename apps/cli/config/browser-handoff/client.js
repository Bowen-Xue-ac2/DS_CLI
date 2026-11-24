window.__ModuleLoader__.load({
  id: '@ds-cli/browser-handoff',
  factory: () => ({
    inject: ['uiWorkspace', 'sessions', 'workspaces', 'layout'],
    apply(ctx) {
      const link = new URL(window.location.href)
      const match = /^#dsh-cli=(session-[\da-f-]{36})$/iu.exec(link.hash)
      if (match === null) return
      const sessionId = match[1]
      let opened = false
      ctx.effect(() => {
        const restore = () => {
          if (opened) return
          const workspaces = ctx.workspaces.list.getSnapshot()
          const sessions = ctx.sessions.list.getSnapshot()
          if (workspaces.phase !== 'ready' || sessions.phase !== 'ready' || sessions.byId[sessionId] === undefined) return
          if (!workspaces.items.some(workspace => workspace.sessionIds.includes(sessionId))
            || workspaces.archivedSessionIds.includes(sessionId)) return
          opened = true
          ctx.layout.beginNavigation()
          ctx.uiWorkspace.openSession(sessionId)
          link.hash = ''
          window.history.replaceState(window.history.state, '', link)
        }
        const stopWorkspaces = ctx.workspaces.list.subscribe(restore)
        const stopSessions = ctx.sessions.list.subscribe(restore)
        restore()
        return () => { stopSessions(); stopWorkspaces() }
      }, 'DS CLI browser handoff')
    },
  }),
})
