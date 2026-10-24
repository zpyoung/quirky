import Foundation

struct RpcError: Error, CustomStringConvertible {
  let code: Int
  let message: String
  var description: String { "rpc error \(code): \(message)" }
}

/// JSON-RPC over `URLSessionWebSocketTask` plus the binary terminal frames
/// `[kind u8 = 1][streamId u32 BE][bytes]`. Stream callbacks and events run on the main queue.
final class DaemonClient: NSObject, @unchecked Sendable {
  private let task: URLSessionWebSocketTask
  private let session: URLSession
  private let lock = NSLock()
  private var nextId = 1
  private var pending: [Int: (Result<Any?, Error>) -> Void] = [:]
  private var streamHandlers: [UInt32: (Data) -> Void] = [:]
  private var streamBuffers: [UInt32: [Data]] = [:]
  private var closed = false

  var onEvent: (([String: Any]) -> Void)?
  var onClose: (() -> Void)?

  init(url: URL) {
    let config = URLSessionConfiguration.ephemeral
    config.urlCache = nil
    session = URLSession(configuration: config)
    task = session.webSocketTask(with: url)
    task.maximumMessageSize = 32 * 1024 * 1024
    super.init()
  }

  /// Connects and performs `client.hello` and `events.subscribe`.
  func connect() async throws {
    task.resume()
    receiveLoop()
    _ = try await call("client.hello", ["role": "desktop", "name": "swift-shell", "protocolVersion": 1])
    _ = try await call("events.subscribe", [:])
  }

  func close() {
    task.cancel(with: .goingAway, reason: nil)
  }

  /// Sends immediately on the calling thread, so successive sends keep their order.
  func send(_ method: String, _ params: [String: Any], completion: ((Result<Any?, Error>) -> Void)? = nil) {
    lock.lock()
    let id = nextId
    nextId += 1
    if let completion { pending[id] = completion }
    lock.unlock()
    let message: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method, "params": params]
    guard let data = try? JSONSerialization.data(withJSONObject: message),
      let text = String(data: data, encoding: .utf8)
    else { return }
    task.send(.string(text)) { [weak self] error in
      if let error { self?.finish(id: id, .failure(error)) }
    }
  }

  func call(_ method: String, _ params: [String: Any]) async throws -> Any? {
    try await withCheckedThrowingContinuation { continuation in
      send(method, params) { continuation.resume(with: $0) }
    }
  }

  func call<R: Decodable>(_ method: String, _ params: [String: Any], as type: R.Type) async throws -> R {
    let result = try await call(method, params)
    let data = try JSONSerialization.data(withJSONObject: result ?? NSNull(), options: .fragmentsAllowed)
    return try JSONDecoder().decode(R.self, from: data)
  }

  /// Registers the handler for a stream and flushes frames that arrived before it existed.
  func onStream(_ streamId: Int, _ handler: @escaping (Data) -> Void) {
    let key = UInt32(streamId)
    streamHandlers[key] = handler
    for chunk in streamBuffers.removeValue(forKey: key) ?? [] { handler(chunk) }
  }

  func removeStream(_ streamId: Int) {
    streamHandlers[UInt32(streamId)] = nil
    streamBuffers[UInt32(streamId)] = nil
  }

  private func finish(id: Int, _ result: Result<Any?, Error>) {
    lock.lock()
    let handler = pending.removeValue(forKey: id)
    lock.unlock()
    handler?(result)
  }

  private func receiveLoop() {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .failure:
        self.handleClose()
      case .success(let message):
        switch message {
        case .data(let data): self.handleBinary(data)
        case .string(let text): self.handleText(Data(text.utf8))
        @unknown default: break
        }
        self.receiveLoop()
      }
    }
  }

  private func handleBinary(_ data: Data) {
    guard data.count >= 5, data[data.startIndex] == 1 else { return }
    let s = data.startIndex
    let streamId =
      UInt32(data[s + 1]) << 24 | UInt32(data[s + 2]) << 16 | UInt32(data[s + 3]) << 8 | UInt32(data[s + 4])
    let bytes = Data(data[(s + 5)...])
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      if let handler = self.streamHandlers[streamId] {
        handler(bytes)
      } else {
        self.streamBuffers[streamId, default: []].append(bytes)
      }
    }
  }

  private func handleText(_ data: Data) {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    if let id = object["id"] as? Int {
      if let error = object["error"] as? [String: Any] {
        finish(
          id: id,
          .failure(RpcError(code: error["code"] as? Int ?? 0, message: error["message"] as? String ?? "")))
      } else {
        finish(id: id, .success(object["result"]))
      }
    } else if object["method"] as? String == "event", let params = object["params"] as? [String: Any] {
      DispatchQueue.main.async { [weak self] in self?.onEvent?(params) }
    }
  }

  private func handleClose() {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    closed = true
    let all = pending
    pending = [:]
    lock.unlock()
    for (_, handler) in all { handler(.failure(RpcError(code: -1, message: "connection closed"))) }
    DispatchQueue.main.async { [weak self] in self?.onClose?() }
  }
}
