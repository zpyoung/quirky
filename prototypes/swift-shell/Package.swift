// swift-tools-version:6.0
import Foundation
import PackageDescription

let packageDir = Context.packageDirectory
let ghosttyKit = "Vendor/GhosttyKit.xcframework"
let hasGhostty = FileManager.default.fileExists(atPath: "\(packageDir)/\(ghosttyKit)")

var dependencies: [Target.Dependency] = [
  .product(name: "SwiftTerm", package: "SwiftTerm")
]
var targets: [Target] = []
var defines: [SwiftSetting] = []
var linker: [LinkerSetting] = []

if hasGhostty {
  targets.append(.binaryTarget(name: "GhosttyKit", path: ghosttyKit))
  dependencies.append("GhosttyKit")
  defines.append(.define("GHOSTTY"))
  linker += [
    .linkedLibrary("c++"),
    .linkedFramework("Metal"),
    .linkedFramework("MetalKit"),
    .linkedFramework("QuartzCore"),
    .linkedFramework("CoreText"),
    .linkedFramework("CoreGraphics"),
    .linkedFramework("CoreVideo"),
    .linkedFramework("IOSurface"),
    .linkedFramework("Carbon"),
    .linkedFramework("AppKit"),
    .linkedFramework("Foundation"),
    .linkedFramework("UniformTypeIdentifiers"),
    .linkedFramework("CoreServices"),
    .linkedFramework("CoreText"),
  ]
}

targets.append(
  .executableTarget(
    name: "QuirkyShell",
    dependencies: dependencies,
    path: "Sources/QuirkyShell",
    swiftSettings: defines,
    linkerSettings: linker
  ))

let package = Package(
  name: "QuirkyShell",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "QuirkyShell", targets: ["QuirkyShell"])],
  dependencies: [
    .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.99.1")
  ],
  targets: targets,
  swiftLanguageModes: [.v5]
)
