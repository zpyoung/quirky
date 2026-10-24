import AppKit
import SwiftTerm

/// A terminal renderer that is fed bytes from outside and reports keystrokes and grid changes.
@MainActor
protocol TerminalEngine: AnyObject {
  var name: String { get }
  var view: NSView { get }
  var gridSize: (cols: Int, rows: Int) { get }
  var onInput: ((Data) -> Void)? { get set }
  var onResize: ((Int, Int) -> Void)? { get set }
  /// Replay bytes are fed with `isReplay` so engines can drop the answers a replayed query provokes.
  func feed(_ data: Data, isReplay: Bool)
  func focus()
  func shutdown()
}

@MainActor
func makeEngine(scrollbackLines: Int) -> TerminalEngine {
  let wanted = ProcessInfo.processInfo.environment["QSWIFT_ENGINE"] ?? "auto"
  #if GHOSTTY
  if wanted != "swiftterm" { return GhosttyEngine(scrollbackLines: scrollbackLines) }
  #endif
  return SwiftTermEngine(scrollbackLines: scrollbackLines)
}

@MainActor
final class SwiftTermEngine: NSObject, TerminalEngine, TerminalViewDelegate {
  let name = "SwiftTerm"
  private let terminalView: TerminalView
  var onInput: ((Data) -> Void)?
  var onResize: ((Int, Int) -> Void)?
  private var suppressUntil: CFAbsoluteTime = 0

  init(scrollbackLines: Int) {
    var options = TerminalOptions()
    options.scrollback = scrollbackLines
    terminalView = TerminalView(
      frame: NSRect(x: 0, y: 0, width: 400, height: 300),
      font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
      options: options)
    super.init()
    terminalView.terminalDelegate = self
  }

  var view: NSView { terminalView }

  private(set) var gridSize: (cols: Int, rows: Int) = (80, 25)

  func feed(_ data: Data, isReplay: Bool) {
    if isReplay { suppressUntil = CFAbsoluteTimeGetCurrent() + 0.6 }
    terminalView.feed(byteArray: [UInt8](data)[...])
  }

  func focus() { terminalView.window?.makeFirstResponder(terminalView) }
  func shutdown() { terminalView.terminalDelegate = nil }

  func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    gridSize = (newCols, newRows)
    onResize?(newCols, newRows)
  }
  func setTerminalTitle(source: TerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  func send(source: TerminalView, data: ArraySlice<UInt8>) {
    if CFAbsoluteTimeGetCurrent() < suppressUntil { return }
    onInput?(Data(data))
  }
  func scrolled(source: TerminalView, position: Double) {}
  func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
  func clipboardCopy(source: TerminalView, content: Data) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setData(content, forType: .string)
  }
  func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}
