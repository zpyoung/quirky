package expo.modules.quirkypageorigin

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class QuirkyPageOriginModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("QuirkyPageOrigin")

    View(QuirkyPageOriginView::class) {
      Events("onLoadState", "onBridgeMessage", "onExternalNavigation")

      Prop("generationDirectory") { view: QuirkyPageOriginView, value: String ->
        view.setGenerationDirectory(value)
      }

      Prop("sessionId") { view: QuirkyPageOriginView, value: String ->
        view.setSessionId(value)
      }

      Prop("bridgeEnabled") { view: QuirkyPageOriginView, value: Boolean ->
        view.setBridgeEnabled(value)
      }

      AsyncFunction("postBridgeMessage") { view: QuirkyPageOriginView, json: String ->
        view.postBridgeMessage(json)
      }

      OnViewDidUpdateProps { view: QuirkyPageOriginView ->
        view.propsDidUpdate()
      }

      OnViewDestroys { view: QuirkyPageOriginView ->
        view.destroyWebView()
      }
    }
  }
}
