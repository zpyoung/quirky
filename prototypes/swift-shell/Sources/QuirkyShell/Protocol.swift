import Foundation

/// Mirrors `RuntimeInfo` in packages/protocol/src/node/index.ts.
struct RuntimeInfo: Decodable {
  let pid: Int
  let port: Int
  let token: String
  let hookToken: String?
  let daemonVersion: String
  let protocolVersion: Int
  let startedAt: Double

  static func load(home: String) -> RuntimeInfo? {
    let url = URL(fileURLWithPath: home).appendingPathComponent("runtime.json")
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(RuntimeInfo.self, from: data)
  }

  var rpcURL: URL {
    let encoded = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
    return URL(string: "ws://127.0.0.1:\(port)/rpc?token=\(encoded)")!
  }

  var uiURL: URL { URL(string: "http://127.0.0.1:\(port)/#token=\(token)")! }
}

struct Repo: Decodable, Hashable {
  let id: String
  let name: String
  let path: String
}

struct Worktree: Decodable, Hashable {
  let id: String
  let repoId: String
  let path: String
  let branch: String?
  let isMain: Bool
  let name: String
}

struct Session: Decodable, Hashable {
  let id: String
  let kind: String
  let agent: String
  let worktreeId: String
  let title: String
  let status: String
  let createdAt: Double
}

struct AttachResult: Decodable {
  let streamId: Int
  let replay: String
  let offset: Int
}
