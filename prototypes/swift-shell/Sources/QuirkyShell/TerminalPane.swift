import AppKit

/// One terminal view bound to one daemon session through `terminal.attach`.
@MainActor
final class TerminalPane {
  let sessionId: String
  let engine: TerminalEngine
  private let client: DaemonClient
  private var streamId: Int?
  private(set) var freshSession = false

  init(session: Session, client: DaemonClient, scrollbackLines: Int) {
    self.sessionId = session.id
    self.client = client
    self.engine = makeEngine(scrollbackLines: scrollbackLines)
    engine.onInput = { [weak self] data in self?.write(data) }
    engine.onResize = { [weak self] cols, rows in self?.resize(cols: cols, rows: rows) }
  }

  var view: NSView { engine.view }

  private func log(_ text: String) {
    if ProcessInfo.processInfo.environment["QSWIFT_TRACE"] != nil { FileHandle.standardError.write(Data("[pane] \(text)\n".utf8)) }
  }

  /// Attaches at the engine's current grid size, writes the replay, then feeds live frames.
  func attach() async throws {
    let grid = engine.gridSize
    log("attach \(sessionId.suffix(6)) at \(grid.cols)x\(grid.rows)")
    let result = try await client.call(
      "terminal.attach",
      ["sessionId": sessionId, "cols": max(grid.cols, 2), "rows": max(grid.rows, 2)],
      as: AttachResult.self)
    streamId = result.streamId
    let replay = Data(base64Encoded: result.replay) ?? Data()
    freshSession = replay.isEmpty
    if !replay.isEmpty { engine.feed(replay, isReplay: true) }
    client.onStream(result.streamId) { [weak self] bytes in self?.engine.feed(bytes, isReplay: false) }
  }

  func detach() {
    engine.onInput = nil
    engine.onResize = nil
    if let streamId {
      client.removeStream(streamId)
      client.send("terminal.detach", ["streamId": streamId])
      self.streamId = nil
    }
    engine.shutdown()
  }

  func write(_ data: Data) {
    client.send("terminal.write", ["sessionId": sessionId, "data": String(decoding: data, as: UTF8.self)])
  }

  func write(_ text: String) { write(Data(text.utf8)) }

  private func resize(cols: Int, rows: Int) {
    guard streamId != nil, cols > 1, rows > 1 else { return }
    log("resize \(sessionId.suffix(6)) to \(cols)x\(rows)")
    client.send("terminal.resize", ["sessionId": sessionId, "cols": cols, "rows": rows])
  }
}
