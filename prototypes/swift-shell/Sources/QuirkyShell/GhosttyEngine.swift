#if GHOSTTY
import AppKit
import GhosttyKit

/// Process-wide libghostty app. Surfaces created from it run in manual IO mode: the embedder
/// feeds output with `ghostty_surface_process_output` and receives keystrokes in `io_write_cb`.
@MainActor
final class GhosttyRuntime {
  static let shared = GhosttyRuntime()
  let app: ghostty_app_t

  private init() {
    var args: [UnsafeMutablePointer<CChar>?] = [strdup("quirky-shell"), nil]
    guard ghostty_init(1, &args) == GHOSTTY_SUCCESS else { fatalError("ghostty_init failed") }
    let config = ghostty_config_new()!
    let scrollbackBytes = Int(ProcessInfo.processInfo.environment["QSWIFT_GHOSTTY_SCROLLBACK_BYTES"] ?? "") ?? 16_000_000
    let text = """
      font-size = 12
      scrollback-limit = \(scrollbackBytes)
      window-padding-x = 2
      window-padding-y = 2
      shell-integration = none
      confirm-close-surface = false
      """
    text.withCString { ptr in
      "quirky".withCString { path in
        ghostty_config_load_string(config, ptr, UInt(strlen(ptr)), path)
      }
    }
    ghostty_config_finalize(config)

    var runtime = ghostty_runtime_config_s()
    runtime.userdata = nil
    runtime.supports_selection_clipboard = false
    runtime.wakeup_cb = { _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { GhosttyRuntime.shared.tick() } }
    }
    runtime.action_cb = { _, _, _ in false }
    runtime.read_clipboard_cb = { _, _, _ in false }
    runtime.confirm_read_clipboard_cb = { _, _, _, _ in }
    runtime.write_clipboard_cb = { _, _, _, _, _ in }
    runtime.close_surface_cb = { _, _ in }
    runtime.tmux_control_cb = nil
    guard let app = ghostty_app_new(&runtime, config) else { fatalError("ghostty_app_new failed") }
    self.app = app
    ghostty_app_set_focus(app, true)
  }

  func tick() { ghostty_app_tick(app) }
}

private let ghosttyWriteCallback: ghostty_io_write_cb = { userdata, bytes, length in
  guard let userdata, let bytes else { return }
  let view = Unmanaged<GhosttySurfaceView>.fromOpaque(userdata).takeUnretainedValue()
  view.receiveWrite(Data(bytes: bytes, count: Int(length)))
}

@MainActor
final class GhosttySurfaceView: NSView {
  private var surface: ghostty_surface_t?
  fileprivate var engineInput: ((Data) -> Void)?
  var onGrid: ((Int, Int) -> Void)?
  private(set) var grid: (cols: Int, rows: Int) = (80, 25)
  private var inKeyEvent = false
  private let suppressLock = NSLock()
  private nonisolated(unsafe) var suppressUntil: CFAbsoluteTime = 0

  override var acceptsFirstResponder: Bool { true }
  override var isFlipped: Bool { false }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
  }

  required init?(coder: NSCoder) { fatalError() }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    guard window != nil, surface == nil else { return }
    var config = ghostty_surface_config_new()
    config.platform_tag = GHOSTTY_PLATFORM_MACOS
    config.platform.macos.nsview = Unmanaged.passUnretained(self).toOpaque()
    config.userdata = Unmanaged.passUnretained(self).toOpaque()
    config.scale_factor = Double(window?.backingScaleFactor ?? 2)
    config.font_size = 0
    config.io_mode = GHOSTTY_SURFACE_IO_MANUAL
    config.io_write_cb = ghosttyWriteCallback
    config.io_write_userdata = Unmanaged.passUnretained(self).toOpaque()
    surface = ghostty_surface_new(GhosttyRuntime.shared.app, &config)
    if let id = window?.screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32, let surface {
      ghostty_surface_set_display_id(surface, id)
    }
    if let surface { ghostty_surface_set_focus(surface, window?.firstResponder === self) }
    syncSize()
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    syncSize()
  }

  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    guard let surface else { return }
    let backing = convertToBacking(frame)
    ghostty_surface_set_content_scale(surface, backing.width / max(frame.width, 1), backing.height / max(frame.height, 1))
    syncSize()
  }

  private func syncSize() {
    guard let surface else { return }
    let backing = convertToBacking(bounds.size)
    guard backing.width >= 1, backing.height >= 1 else { return }
    ghostty_surface_set_size(surface, UInt32(backing.width), UInt32(backing.height))
    let size = ghostty_surface_size(surface)
    let next = (Int(size.columns), Int(size.rows))
    if next != (grid.cols, grid.rows) {
      grid = next
      onGrid?(next.0, next.1)
    }
  }

  func feed(_ data: Data, isReplay: Bool) {
    guard let surface else { return }
    if isReplay {
      suppressLock.lock()
      suppressUntil = CFAbsoluteTimeGetCurrent() + 0.4
      suppressLock.unlock()
    }
    data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress?.assumingMemoryBound(to: CChar.self) else { return }
      ghostty_surface_process_output(surface, base, UInt(raw.count))
    }
  }

  nonisolated func receiveWrite(_ data: Data) {
    if Thread.isMainThread {
      MainActor.assumeIsolated { self.engineInput?(data) }
      return
    }
    suppressLock.lock()
    let dropped = CFAbsoluteTimeGetCurrent() < suppressUntil
    suppressLock.unlock()
    if dropped { return }
    DispatchQueue.main.async { MainActor.assumeIsolated { self.engineInput?(data) } }
  }

  func free() {
    if let surface { ghostty_surface_free(surface) }
    surface = nil
  }

  override func becomeFirstResponder() -> Bool {
    if let surface { ghostty_surface_set_focus(surface, true) }
    return true
  }

  override func resignFirstResponder() -> Bool {
    if let surface { ghostty_surface_set_focus(surface, false) }
    return true
  }

  private func mods(_ flags: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
    var raw: UInt32 = 0
    if flags.contains(.shift) { raw |= GHOSTTY_MODS_SHIFT.rawValue }
    if flags.contains(.control) { raw |= GHOSTTY_MODS_CTRL.rawValue }
    if flags.contains(.option) { raw |= GHOSTTY_MODS_ALT.rawValue }
    if flags.contains(.command) { raw |= GHOSTTY_MODS_SUPER.rawValue }
    if flags.contains(.capsLock) { raw |= GHOSTTY_MODS_CAPS.rawValue }
    return ghostty_input_mods_e(rawValue: raw)
  }

  private func sendKey(_ event: NSEvent, action: ghostty_input_action_e) {
    guard let surface else { return }
    var key = ghostty_input_key_s()
    key.action = action
    key.keycode = UInt32(event.keyCode)
    key.mods = mods(event.modifierFlags)
    key.consumed_mods = mods(event.modifierFlags.subtracting([.control, .command]))
    key.composing = false
    key.unshifted_codepoint = event.characters(byApplyingModifiers: [])?.unicodeScalars.first?.value ?? 0
    var text: String?
    if action != GHOSTTY_ACTION_RELEASE, let characters = event.characters, let scalar = characters.unicodeScalars.first {
      if scalar.value < 0x20 {
        text = event.characters(byApplyingModifiers: event.modifierFlags.subtracting(.control))
      } else if !(0xF700...0xF8FF).contains(scalar.value) {
        text = characters
      }
      if let t = text, t.unicodeScalars.first.map({ $0.value < 0x20 }) ?? true { text = nil }
    }
    inKeyEvent = true
    if let text {
      text.withCString { ptr in
        key.text = ptr
        _ = ghostty_surface_key(surface, key)
      }
    } else {
      _ = ghostty_surface_key(surface, key)
    }
    inKeyEvent = false
  }

  override func keyDown(with event: NSEvent) {
    sendKey(event, action: event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS)
  }

  override func keyUp(with event: NSEvent) { sendKey(event, action: GHOSTTY_ACTION_RELEASE) }

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    guard window?.firstResponder === self, event.modifierFlags.contains(.control) else { return false }
    sendKey(event, action: GHOSTTY_ACTION_PRESS)
    return true
  }

  override func scrollWheel(with event: NSEvent) {
    guard let surface else { return }
    var x = event.scrollingDeltaX
    var y = event.scrollingDeltaY
    var scrollMods: Int32 = 0
    if event.hasPreciseScrollingDeltas {
      scrollMods = 1
      x *= 2
      y *= 2
    }
    ghostty_surface_mouse_scroll(surface, x, y, scrollMods)
  }

  override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }
}

@MainActor
final class GhosttyEngine: TerminalEngine {
  let name = "libghostty (manual IO)"
  private let surfaceView = GhosttySurfaceView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
  var onInput: ((Data) -> Void)? { didSet { surfaceView.engineInput = onInput } }
  var onResize: ((Int, Int) -> Void)? { didSet { surfaceView.onGrid = onResize } }

  init(scrollbackLines: Int) {}

  var view: NSView { surfaceView }
  var gridSize: (cols: Int, rows: Int) { surfaceView.grid }
  func feed(_ data: Data, isReplay: Bool) { surfaceView.feed(data, isReplay: isReplay) }
  func focus() { surfaceView.window?.makeFirstResponder(surfaceView) }
  func shutdown() { surfaceView.free() }
}
#endif
