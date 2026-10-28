package expo.modules.quirkypageorigin

import java.io.File
import org.json.JSONArray
import org.json.JSONObject

private const val MOBILE_WEB_SHELL_MANIFEST_NAME = "manifest.json"
private const val MOBILE_WEB_SHELL_MANIFEST_CONTENT_TYPE = "application/json"
private const val MOBILE_WEB_SHELL_SCHEMA_VERSION = 1
private const val MOBILE_WEB_SHELL_SHELL_VERSION = 1
private const val MOBILE_WEB_SHELL_ENTRYPOINT = "index.html"
private const val MOBILE_WEB_SHELL_MAX_ASSETS = 256
private const val MOBILE_WEB_SHELL_MAX_TOTAL_BYTES = 32 * 1024 * 1024
private const val MOBILE_WEB_SHELL_MAX_ASSET_BYTES = 10 * 1024 * 1024
private const val MOBILE_WEB_SHELL_MAX_ASSET_PATH_LENGTH = 1024
private const val MOBILE_WEB_SHELL_MAX_CONTENT_TYPE_LENGTH = 128

internal data class MobileWebShellAsset(val file: File, val contentType: String)

/**
 * The served surface of one activated generation: a request path to file map, built once from the
 * manifest before anything loads. Serving is a lookup in this map and never a path join at request
 * time, so "not in the manifest" is a refusal by construction rather than by sanitiser.
 *
 * Asset bytes are not re-hashed here. The TypeScript store verified every byte against the manifest
 * before the activating rename, and the directory path is one the app owns and the page can never
 * influence.
 */
internal class MobileWebShellGeneration private constructor(
  val entries: Map<String, MobileWebShellAsset>
) {
  companion object {
    fun load(directoryPath: String): MobileWebShellGeneration? {
      if (!directoryPath.startsWith("/")) return null
      val directory = File(directoryPath)
      val manifest = runCatching {
        File(directory, MOBILE_WEB_SHELL_MANIFEST_NAME).readText(Charsets.UTF_8)
      }.getOrNull() ?: return null
      return make(manifest, directory)
    }

    fun make(manifestJson: String, directory: File): MobileWebShellGeneration? {
      val root = runCatching { JSONObject(manifestJson) }.getOrNull() ?: return null
      if (!root.hasExactKeys(setOf("v", "shellVersion", "buildId", "assets", "totalBytes", "routes"))) return null
      if (root.opt("v") != MOBILE_WEB_SHELL_SCHEMA_VERSION || root.opt("shellVersion") != MOBILE_WEB_SHELL_SHELL_VERSION) return null
      val buildId = root.opt("buildId") as? String ?: return null
      if (!Regex("^[0-9a-f]{64}$").matches(buildId)) return null
      val totalBytes = root.opt("totalBytes") as? Int ?: return null
      if (totalBytes !in 1..MOBILE_WEB_SHELL_MAX_TOTAL_BYTES) return null
      val assets = root.opt("assets") as? JSONArray ?: return null
      if (assets.length() == 0 || assets.length() > MOBILE_WEB_SHELL_MAX_ASSETS) return null
      val routes = root.opt("routes") as? JSONArray ?: return null
      if (routes.length() != 2) return null

      val entries = mutableMapOf<String, MobileWebShellAsset>()
      var declaredTotal = 0L
      for (index in 0 until assets.length()) {
        val asset = assets.opt(index) as? JSONObject ?: return null
        if (!asset.hasExactKeys(setOf("path", "bytes", "sha256", "contentType"))) return null
        val path = asset.opt("path") as? String ?: return null
        val byteCount = asset.opt("bytes") as? Int ?: return null
        val hash = asset.opt("sha256") as? String ?: return null
        val contentType = asset.opt("contentType") as? String ?: return null
        if (!isServableAssetPath(path) || byteCount !in 1..MOBILE_WEB_SHELL_MAX_ASSET_BYTES ||
          !Regex("^[0-9a-f]{64}$").matches(hash) || !isServableContentType(contentType) || entries.containsKey("/$path")) return null
        declaredTotal += byteCount.toLong()
        entries["/$path"] = MobileWebShellAsset(File(directory, path), contentType)
      }
      if (declaredTotal != totalBytes.toLong()) return null
      val document = entries.remove("/$MOBILE_WEB_SHELL_ENTRYPOINT") ?: return null
      entries["/"] = document
      entries["/$MOBILE_WEB_SHELL_MANIFEST_NAME"] = MobileWebShellAsset(
        File(directory, MOBILE_WEB_SHELL_MANIFEST_NAME),
        MOBILE_WEB_SHELL_MANIFEST_CONTENT_TYPE
      )
      return MobileWebShellGeneration(entries)
    }

    private fun JSONObject.hasExactKeys(expected: Set<String>): Boolean =
      keys().asSequence().toSet() == expected

    /**
     * Re-checked here rather than trusted: the schema that pins this shape is on the other side of
     * a file the native layer cannot see change.
     */
    fun isServableAssetPath(path: String): Boolean {
      if (path.isEmpty() || path.toByteArray(Charsets.UTF_8).size > MOBILE_WEB_SHELL_MAX_ASSET_PATH_LENGTH ||
        path.contains('%') || path.contains(92.toChar()) || path.contains(0.toChar())) return false
      return path.split('/').all { segment ->
        segment.isNotEmpty() && segment.length <= 128 && segment != "." && segment != ".." &&
          segment.first().let { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' } &&
          segment.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '.' || it == '_' || it == '@' || it == '-' }
      }
    }

    /**
     * This value becomes a response header, so it must not be able to carry a second header or a
     * parameter we did not intend. One lowercase type, one optional charset: the manifest
     * contract's only accepted spelling.
     */
    fun isServableContentType(contentType: String): Boolean {
      if (contentType.isEmpty() ||
        contentType.toByteArray(Charsets.UTF_8).size > MOBILE_WEB_SHELL_MAX_CONTENT_TYPE_LENGTH
      ) {
        return false
      }
      var type = contentType
      val separator = contentType.indexOf("; charset=")
      if (separator >= 0) {
        val charset = contentType.substring(separator + "; charset=".length)
        if (charset.isEmpty()) return false
        if (!charset.all { it in 'a'..'z' || it in '0'..'9' || it == '-' }) return false
        type = contentType.substring(0, separator)
      }
      val halves = type.split('/')
      if (halves.size != 2) return false
      return halves.all(::isMimeToken)
    }

    private fun isMimeToken(token: String): Boolean {
      val first = token.firstOrNull() ?: return false
      if (!(first in 'a'..'z' || first in '0'..'9')) return false
      return token.all { it in 'a'..'z' || it in '0'..'9' || it == '.' || it == '+' || it == '-' }
    }
  }
}

/** `WebResourceResponse` takes the mime type and the encoding separately. */
internal fun splitMobileWebShellContentType(contentType: String): Pair<String, String?> {
  val separator = contentType.indexOf("; charset=")
  if (separator < 0) return contentType to null
  return contentType.substring(0, separator) to
    contentType.substring(separator + "; charset=".length)
}
