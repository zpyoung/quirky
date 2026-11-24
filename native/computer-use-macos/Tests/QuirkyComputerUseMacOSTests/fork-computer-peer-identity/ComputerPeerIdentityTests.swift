import XCTest
@testable import QuirkyComputerUseMacOSCore

final class ComputerPeerIdentityTests: XCTestCase {
    func testAcceptsPackagedFork() {
        XCTAssertTrue(isTrustedComputerPeerBundleIdentifier("com.zpyoung.quirky"))
    }

    func testPreservesUpstreamAndDevelopmentApplications() {
        XCTAssertTrue(isTrustedComputerPeerBundleIdentifier("com.zpyoung.quirky"))
        XCTAssertTrue(isTrustedComputerPeerBundleIdentifier("com.zpyoung.quirky.dev.worktree"))
        XCTAssertTrue(isTrustedComputerPeerBundleIdentifier("com.github.Electron"))
    }

    func testRejectsUnrelatedAndLookalikeApplications() {
        for bundleId in ["", "com.example.app", "com.zpyoung.quirky.evil", "com.zpyoung.quirky-helper", "com.zpyoung.quirky.evil", "com.github.Electron.evil"] {
            XCTAssertFalse(isTrustedComputerPeerBundleIdentifier(bundleId), bundleId)
        }
    }
}
