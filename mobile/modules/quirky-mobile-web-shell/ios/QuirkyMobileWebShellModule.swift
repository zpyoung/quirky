import ExpoModulesCore

public class QuirkyMobileWebShellModule: Module {
  public func definition() -> ModuleDefinition {
    Name("QuirkyMobileWebShell")

    View(QuirkyMobileWebShellView.self) {
      Events("onLoadState", "onBridgeMessage", "onExternalNavigation")

      Prop("generationDirectory") { (view: QuirkyMobileWebShellView, value: String) in
        view.setGenerationDirectory(value)
      }

      Prop("sessionId") { (view: QuirkyMobileWebShellView, value: String) in
        view.setSessionId(value)
      }

      Prop("bridgeEnabled") { (view: QuirkyMobileWebShellView, value: Bool) in
        view.setBridgeEnabled(value)
      }

      AsyncFunction("postBridgeMessage") {
        (view: QuirkyMobileWebShellView, json: String, promise: Promise) in
        try view.postBridgeMessage(json, promise: promise)
      }

      OnViewDidUpdateProps { (view: QuirkyMobileWebShellView) in
        view.propsDidUpdate()
      }
    }
  }
}
