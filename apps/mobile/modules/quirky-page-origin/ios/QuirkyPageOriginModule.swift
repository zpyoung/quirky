import ExpoModulesCore

public class QuirkyPageOriginModule: Module {
  public func definition() -> ModuleDefinition {
    Name("QuirkyPageOrigin")

    View(QuirkyPageOriginView.self) {
      Events("onLoadState", "onBridgeMessage", "onExternalNavigation")

      Prop("generationDirectory") { (view: QuirkyPageOriginView, value: String) in
        view.setGenerationDirectory(value)
      }

      Prop("sessionId") { (view: QuirkyPageOriginView, value: String) in
        view.setSessionId(value)
      }

      Prop("bridgeEnabled") { (view: QuirkyPageOriginView, value: Bool) in
        view.setBridgeEnabled(value)
      }

      AsyncFunction("postBridgeMessage") {
        (view: QuirkyPageOriginView, json: String, promise: Promise) in
        try view.postBridgeMessage(json, promise: promise)
      }

      OnViewDidUpdateProps { (view: QuirkyPageOriginView) in
        view.propsDidUpdate()
      }
    }
  }
}
