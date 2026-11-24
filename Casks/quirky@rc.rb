cask "quirky@rc" do
  arch arm: "arm64", intel: "x64"

  version "1.4.36-rc.3"
  sha256 arm:   "563b6b14323fc9d5489299c82442d514bc12cabffc9d06d3964ed572af4b3955",
         intel: "457088c7021f07de1a419197f7b2bd00092741ad4727d4fef3d86af38a6831e7"

  url "https://github.com/stablyai/orca/releases/download/v#{version}/quirky-macos-#{arch}.dmg"
  name "Quirky RC"
  desc "IDE for orchestrating AI coding agents across terminals and worktrees"
  homepage "https://onorca.dev/"

  livecheck do
    url "https://github.com/stablyai/orca"
    regex(/^v?(\d+(?:\.\d+)+-rc\.\d+)$/i)
    strategy :github_releases do |json, regex|
      json.map do |release|
        next if release["draft"]
        next unless release["prerelease"]

        match = release["tag_name"]&.match(regex)
        next if match.blank?

        match[1]
      end
    end
  end

  # Why: RC installs should follow Quirky's prerelease-aware updater instead of
  # waiting for Homebrew metadata churn between frequent release candidates.
  auto_updates true
  conflicts_with cask: "quirky"
  depends_on macos: :big_sur

  app "Quirky.app"

  # Why: expose the bundled `quirky` CLI on PATH at install time (Homebrew symlinks
  # this into its already-on-PATH bin dir). Without it, the CLI is only registered
  # by the in-app "Install CLI" action, which a headless host can never trigger —
  # so `quirky serve` on a server would be unreachable from the shell. The shim
  # resolves the real app by walking symlinks, so the Homebrew symlink works.
  binary "#{appdir}/Quirky.app/Contents/Resources/bin/quirky"

  # Why: Quirky writes user data under ~/.quirky (worktrees, agent state) and
  # Electron's standard userData directories. Zap removes everything the app
  # creates during normal use so `brew uninstall --zap` is a clean slate.
  zap trash: [
    "~/.quirky",
    "~/Library/Application Support/Quirky",
    "~/Library/Caches/com.zpyoung.quirky",
    "~/Library/Caches/com.zpyoung.quirky.ShipIt",
    "~/Library/HTTPStorages/com.zpyoung.quirky",
    "~/Library/Preferences/com.zpyoung.quirky.plist",
    "~/Library/Saved Application State/com.zpyoung.quirky.savedState",
  ]
end
