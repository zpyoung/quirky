import AppKit
import WebKit

private final class OutlineNode: NSObject {
  let repo: Repo?
  let worktree: Worktree?
  var children: [OutlineNode] = []
  init(repo: Repo) { self.repo = repo; self.worktree = nil }
  init(worktree: Worktree) { self.repo = nil; self.worktree = worktree }
}

struct ShellConfig {
  let home: String
  let paneCount: Int
  let scrollbackLines: Int
  let fillLines: Int
  let addRepoPath: String?

  static func fromEnvironment() -> ShellConfig {
    let env = ProcessInfo.processInfo.environment
    let home = env["QUIRKY_HOME"] ?? (NSHomeDirectory() + "/.quirky")
    return ShellConfig(
      home: home,
      paneCount: Int(env["QSWIFT_PANES"] ?? "") ?? 2,
      scrollbackLines: Int(env["QSWIFT_SCROLLBACK"] ?? "") ?? 10000,
      fillLines: Int(env["QSWIFT_FILL"] ?? "") ?? 0,
      addRepoPath: env["QSWIFT_ADD_REPO"])
  }
}

/// The one window: worktree sidebar, terminal panes, and a lazily created WKWebView panel.
@MainActor
final class ShellController: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate, NSWindowDelegate,
  NSSplitViewDelegate
{
  let config: ShellConfig
  let window: NSWindow
  private let splitView = NSSplitView()
  private let outline = NSOutlineView()
  private let panesContainer = NSView()
  private let webContainer = NSView()
  private let statusLabel = NSTextField(labelWithString: "connecting")
  private var webView: WKWebView?
  private var webVisible = false
  private var roots: [OutlineNode] = []
  private var panes: [TerminalPane] = []
  private var client: DaemonClient?
  private var runtime: RuntimeInfo?
  private var selectedWorktreeId: String?
  private var showGeneration = 0

  init(config: ShellConfig) {
    self.config = config
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1400, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    super.init()
    window.title = "Quirky (Swift prototype)"
    window.delegate = self
    buildLayout()
    window.center()
  }

  private func buildLayout() {
    let sidebarScroll = NSScrollView()
    let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
    column.title = "Worktrees"
    outline.addTableColumn(column)
    outline.outlineTableColumn = column
    outline.headerView = nil
    outline.dataSource = self
    outline.delegate = self
    outline.style = .sourceList
    sidebarScroll.documentView = outline
    sidebarScroll.hasVerticalScroller = true
    sidebarScroll.widthAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true

    statusLabel.font = .systemFont(ofSize: 11)
    statusLabel.textColor = .secondaryLabelColor
    statusLabel.translatesAutoresizingMaskIntoConstraints = false
    let sidebar = NSView()
    sidebarScroll.translatesAutoresizingMaskIntoConstraints = false
    sidebar.addSubview(sidebarScroll)
    sidebar.addSubview(statusLabel)
    NSLayoutConstraint.activate([
      sidebarScroll.topAnchor.constraint(equalTo: sidebar.topAnchor),
      sidebarScroll.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor),
      sidebarScroll.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor),
      sidebarScroll.bottomAnchor.constraint(equalTo: statusLabel.topAnchor, constant: -4),
      statusLabel.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 8),
      statusLabel.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -8),
      statusLabel.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor, constant: -6),
    ])

    splitView.isVertical = true
    splitView.dividerStyle = .thin
    splitView.delegate = self
    splitView.addArrangedSubview(sidebar)
    splitView.addArrangedSubview(panesContainer)
    splitView.addArrangedSubview(webContainer)
    webContainer.isHidden = true
    splitView.setHoldingPriority(.defaultHigh, forSubviewAt: 0)
    splitView.setHoldingPriority(.defaultLow, forSubviewAt: 1)
    splitView.setHoldingPriority(.defaultHigh - 1, forSubviewAt: 2)
    window.contentView = splitView
    splitView.setPosition(240, ofDividerAt: 0)
  }

  func splitView(_ splitView: NSSplitView, canCollapseSubview subview: NSView) -> Bool {
    subview === webContainer
  }

  func start() {
    window.makeKeyAndOrderFront(nil)
    Task { @MainActor in
      do {
        try await self.connect()
      } catch {
        self.setStatus("connect failed: \(error)")
      }
    }
  }

  private func setStatus(_ text: String) {
    statusLabel.stringValue = text
    FileHandle.standardError.write(Data("[shell] \(text)\n".utf8))
  }

  private func connect() async throws {
    var info: RuntimeInfo?
    for _ in 0..<150 {
      info = RuntimeInfo.load(home: config.home)
      if info != nil { break }
      try await Task.sleep(nanoseconds: 200_000_000)
    }
    guard let info else { throw RpcError(code: -1, message: "no runtime.json in \(config.home)") }
    runtime = info
    let client = DaemonClient(url: info.rpcURL)
    client.onEvent = { [weak self] event in self?.handleEvent(event) }
    client.onClose = { [weak self] in self?.setStatus("daemon connection closed") }
    try await client.connect()
    self.client = client
    setStatus("connected pid \(info.pid) port \(info.port)")
    if let path = config.addRepoPath {
      let repos = try await client.call("repo.list", [:], as: [Repo].self)
      if repos.isEmpty { _ = try await client.call("repo.add", ["path": path]) }
    }
    try await reloadSidebar()
    if config.paneCount > 0, let first = roots.first?.children.first, let wt = first.worktree {
      outline.selectRowIndexes(IndexSet(integer: outline.row(forItem: first)), byExtendingSelection: false)
      await showWorktree(wt)
    }
  }

  private func handleEvent(_ event: [String: Any]) {
    switch event["type"] as? String {
    case "repo.changed", "worktree.changed":
      Task { @MainActor in try? await self.reloadSidebar() }
    default: break
    }
  }

  private func reloadSidebar() async throws {
    guard let client else { return }
    let repos = try await client.call("repo.list", [:], as: [Repo].self)
    let worktrees = try await client.call("worktree.list", [:], as: [Worktree].self)
    roots = repos.map { repo in
      let node = OutlineNode(repo: repo)
      node.children = worktrees.filter { $0.repoId == repo.id }.map(OutlineNode.init(worktree:))
      return node
    }
    outline.reloadData()
    outline.expandItem(nil, expandChildren: true)
  }

  func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
    (item as? OutlineNode)?.children.count ?? roots.count
  }

  func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
    (item as? OutlineNode)?.children[index] ?? roots[index]
  }

  func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
    !((item as? OutlineNode)?.children.isEmpty ?? true)
  }

  func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
    guard let node = item as? OutlineNode else { return nil }
    let id = NSUserInterfaceItemIdentifier("cell")
    let cell =
      (outlineView.makeView(withIdentifier: id, owner: nil) as? NSTableCellView)
      ?? {
        let cell = NSTableCellView()
        cell.identifier = id
        let text = NSTextField(labelWithString: "")
        text.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(text)
        cell.textField = text
        NSLayoutConstraint.activate([
          text.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2),
          text.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -2),
          text.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
      }()
    cell.textField?.stringValue = node.repo?.name ?? node.worktree?.name ?? ""
    cell.textField?.font = node.repo != nil ? .boldSystemFont(ofSize: 12) : .systemFont(ofSize: 12)
    return cell
  }

  func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool {
    (item as? OutlineNode)?.worktree != nil
  }

  func outlineViewSelectionDidChange(_ notification: Notification) {
    guard let node = outline.item(atRow: outline.selectedRow) as? OutlineNode, let wt = node.worktree else {
      return
    }
    Task { @MainActor in await self.showWorktree(wt) }
  }

  @MainActor
  private func showWorktree(_ worktree: Worktree) async {
    guard let client, worktree.id != selectedWorktreeId else { return }
    selectedWorktreeId = worktree.id
    showGeneration += 1
    let generation = showGeneration
    tearDownPanes()
    do {
      var sessions = try await client.call(
        "session.list", ["worktreeId": worktree.id], as: [Session].self
      ).filter { $0.kind == "terminal" && $0.status != "exited" }
      while sessions.count < config.paneCount {
        let created = try await client.call(
          "session.create", ["worktreeId": worktree.id, "agent": "shell", "cols": 100, "rows": 30],
          as: Session.self)
        sessions.append(created)
      }
      guard generation == showGeneration else { return }
      let chosen = Array(sessions.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }.prefix(config.paneCount))
      panes = chosen.map { TerminalPane(session: $0, client: client, scrollbackLines: config.scrollbackLines) }
      layoutPanes()
      window.contentView?.layoutSubtreeIfNeeded()
      try? await Task.sleep(nanoseconds: 300_000_000)
      for pane in panes {
        try await pane.attach()
        if config.fillLines > 0 && pane.freshSession { pane.write("seq 1 \(config.fillLines)\r") }
      }
      panes.first?.engine.focus()
      setStatus("\(panes.first?.engine.name ?? "?"): \(panes.count) panes on \(worktree.name)")
    } catch {
      setStatus("show worktree failed: \(error)")
    }
  }

  private func layoutPanes() {
    panesContainer.subviews.forEach { $0.removeFromSuperview() }
    let count = panes.count
    guard count > 0 else { return }
    let perRow = count > 2 ? (count + 1) / 2 : count
    let rows = stride(from: 0, to: count, by: perRow).map { start -> NSStackView in
      let row = NSStackView(views: panes[start..<min(start + perRow, count)].map(containerView(for:)))
      row.orientation = .horizontal
      row.distribution = .fillEqually
      row.spacing = 2
      return row
    }
    let grid = NSStackView(views: rows)
    grid.orientation = .vertical
    grid.distribution = .fillEqually
    grid.spacing = 2
    grid.translatesAutoresizingMaskIntoConstraints = false
    panesContainer.addSubview(grid)
    NSLayoutConstraint.activate([
      grid.topAnchor.constraint(equalTo: panesContainer.topAnchor),
      grid.bottomAnchor.constraint(equalTo: panesContainer.bottomAnchor),
      grid.leadingAnchor.constraint(equalTo: panesContainer.leadingAnchor),
      grid.trailingAnchor.constraint(equalTo: panesContainer.trailingAnchor),
    ])
  }

  /// Hosts a terminal view by autoresizing so engines that size themselves (SwiftTerm) don't fight stack constraints.
  private func containerView(for pane: TerminalPane) -> NSView {
    let container = NSView()
    container.translatesAutoresizingMaskIntoConstraints = false
    container.widthAnchor.constraint(greaterThanOrEqualToConstant: 60).isActive = true
    container.heightAnchor.constraint(greaterThanOrEqualToConstant: 60).isActive = true
    pane.view.frame = container.bounds
    pane.view.autoresizingMask = [.width, .height]
    pane.view.translatesAutoresizingMaskIntoConstraints = true
    container.addSubview(pane.view)
    return container
  }

  private func tearDownPanes() {
    for pane in panes { pane.detach() }
    panes.removeAll()
    panesContainer.subviews.forEach { $0.removeFromSuperview() }
  }

  /// The WKWebView is created on the first call, never before.
  func toggleWebPanel() {
    guard let runtime else { return }
    if webView == nil {
      let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
      view.translatesAutoresizingMaskIntoConstraints = false
      webContainer.addSubview(view)
      NSLayoutConstraint.activate([
        view.topAnchor.constraint(equalTo: webContainer.topAnchor),
        view.bottomAnchor.constraint(equalTo: webContainer.bottomAnchor),
        view.leadingAnchor.constraint(equalTo: webContainer.leadingAnchor),
        view.trailingAnchor.constraint(equalTo: webContainer.trailingAnchor),
      ])
      let override = ProcessInfo.processInfo.environment["QSWIFT_WEB_URL"].flatMap(URL.init(string:))
      view.load(URLRequest(url: override ?? runtime.uiURL))
      webView = view
    }
    webVisible.toggle()
    webContainer.isHidden = !webVisible
    if webVisible {
      splitView.setPosition(splitView.bounds.width - 480, ofDividerAt: 1)
    }
    setStatus(webVisible ? "web panel shown" : "web panel hidden")
  }

  func toggleWindowWidth() {
    var frame = window.frame
    frame.size.width = frame.size.width > 1000 ? 900 : 1400
    window.setFrame(frame, display: true, animate: false)
  }

  func printDiagnostics() {
    let id = window.windowNumber
    FileHandle.standardError.write(Data("[shell] windowNumber=\(id) pid=\(getpid())\n".utf8))
  }

  func windowWillClose(_ notification: Notification) {
    tearDownPanes()
    client?.close()
    NSApp.terminate(nil)
  }
}
