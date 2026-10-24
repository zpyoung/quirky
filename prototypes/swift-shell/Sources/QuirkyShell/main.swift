import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  var shell: ShellController?
  var signals: [DispatchSourceSignal] = []

  func applicationDidFinishLaunching(_ notification: Notification) {
    let shell = ShellController(config: .fromEnvironment())
    self.shell = shell
    installMenu()
    shell.start()
    for (sig, action) in [
      (SIGUSR1, { shell.toggleWebPanel() }),
      (SIGUSR2, { shell.toggleWindowWidth() }),
      (SIGINFO, { shell.printDiagnostics() }),
    ] as [(Int32, @MainActor () -> Void)] {
      signal(sig, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
      source.setEventHandler { MainActor.assumeIsolated { action() } }
      source.resume()
      signals.append(source)
    }
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  private func installMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    let viewItem = NSMenuItem()
    main.addItem(viewItem)
    let viewMenu = NSMenu(title: "View")
    let toggle = NSMenuItem(title: "Toggle Web Panel", action: #selector(toggleWeb), keyEquivalent: "b")
    toggle.target = self
    viewMenu.addItem(toggle)
    viewItem.submenu = viewMenu
    NSApp.mainMenu = main
  }

  @objc func toggleWeb() { shell?.toggleWebPanel() }
}

MainActor.assumeIsolated {
  let app = NSApplication.shared
  app.setActivationPolicy(.regular)
  let delegate = AppDelegate()
  app.delegate = delegate
  app.run()
}
