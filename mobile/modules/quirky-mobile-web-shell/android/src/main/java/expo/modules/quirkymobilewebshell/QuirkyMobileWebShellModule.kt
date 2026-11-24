package expo.modules.quirkymobilewebshell

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class QuirkyMobileWebShellModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("QuirkyMobileWebShell")

    View(QuirkyMobileWebShellView::class) {
      Events("onLoadState", "onBridgeMessage", "onExternalNavigation")

      Prop("generationDirectory") { view: QuirkyMobileWebShellView, value: String ->
        view.setGenerationDirectory(value)
      }

      Prop("sessionId") { view: QuirkyMobileWebShellView, value: String ->
        view.setSessionId(value)
      }

      Prop("bridgeEnabled") { view: QuirkyMobileWebShellView, value: Boolean ->
        view.setBridgeEnabled(value)
      }

      AsyncFunction("postBridgeMessage") { view: QuirkyMobileWebShellView, json: String ->
        view.postBridgeMessage(json)
      }

      OnViewDidUpdateProps { view: QuirkyMobileWebShellView ->
        view.propsDidUpdate()
      }

      OnViewDestroys { view: QuirkyMobileWebShellView ->
        view.destroyWebView()
      }
    }
  }
}
