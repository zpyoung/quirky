public func isTrustedComputerPeerBundleIdentifier(_ bundleId: String) -> Bool {
    return bundleId == "com.zpyoung.quirky" ||
        bundleId == "com.zpyoung.quirky" ||
        bundleId.hasPrefix("com.zpyoung.quirky.dev.") ||
        bundleId == "com.github.Electron"
}
