// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "QuirkyComputerUseMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "QuirkyComputerUseMacOSCore",
            targets: ["QuirkyComputerUseMacOSCore"]
        ),
        .executable(
            name: "quirky-computer-use-macos",
            targets: ["QuirkyComputerUseMacOS"]
        )
    ],
    targets: [
        .target(
            name: "QuirkyComputerUseMacOSCore",
            path: "Sources/QuirkyComputerUseMacOSCore"
        ),
        .executableTarget(
            name: "QuirkyComputerUseMacOS",
            dependencies: ["QuirkyComputerUseMacOSCore"],
            path: "Sources/QuirkyComputerUseMacOS"
        ),
        .testTarget(
            name: "QuirkyComputerUseMacOSTests",
            dependencies: ["QuirkyComputerUseMacOSCore"],
            path: "Tests/QuirkyComputerUseMacOSTests"
        )
    ]
)
