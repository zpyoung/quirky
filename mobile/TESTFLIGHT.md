# Shipping Quirky Mobile to TestFlight

Getting Quirky Mobile onto your iPhone takes a one-time Apple setup, six GitHub secrets, and then a single workflow run each time you release. Everything runs under your own Apple Developer account, and the upload runs on GitHub Actions (`.github/workflows/mobile-ios-release.yml`).

You'll need a paid Apple Developer Program membership and admin access to `zpyoung/quirky`.

## 1. Set up Apple, once

Do these in order. Each step depends on the one before it.

1. **Register the App ID.** In the [Developer portal](https://developer.apple.com/account/resources/identifiers/list), add an explicit App ID with the bundle ID `com.zpyoung.quirky.mobile`. **Turn on the Push Notifications capability.** The build signs with a push entitlement, and signing fails if the App ID doesn't have it. Notifications won't actually reach the phone yet (see [What doesn't work yet](#what-doesnt-work-yet)).
2. **Create the app record.** In [App Store Connect](https://appstoreconnect.apple.com/apps), add a new iOS app with that bundle ID. App names have to be unique across the whole store, so if "Quirky" is taken, use something like "Quirky Mobile". The SKU can be anything, for example `quirky-mobile`.
3. **Create an internal tester group.** In the app's TestFlight tab, add an internal group, turn on **automatic distribution**, and add yourself. You need to be a user on the team with App Store Connect access. Internal builds skip Apple's beta review, and every processed build reaches the group without any further step.
4. **Create an API key.** In App Store Connect, go to Users and Access > Integrations > App Store Connect API > Team Keys and generate a key with the **App Manager** role. Write down the **Issuer ID** (shown above the key list) and the **Key ID**, then download the `.p8` file. Apple lets you download it only once, so keep it somewhere safe.
5. **Create a distribution certificate.** In Xcode, open Settings > Accounts, select your team, click Manage Certificates, then **+** > Apple Distribution. Then in Keychain Access, find "Apple Distribution: …" under My Certificates, right-click it, choose Export, and save it as a `.p12` file with a password.
6. **Find your Team ID.** It's under Membership details on [your account page](https://developer.apple.com/account).

## Testers outside your team

The workflow only uploads, so builds reach internal testers alone. External testers (anyone not on your App Store Connect team) need an external group, Apple's beta review, and test information such as a description and a feedback email. They also need a step that sends each build to that group, which this workflow doesn't have.

If you later turn on a public TestFlight link, set it as `QUIRKY_IOS_INSTALL_URL` in `src/shared/mobile-install-links.ts`. That brings back the install buttons in desktop Settings > Mobile and on the Quirky Mobile page. They stay hidden while the value is `null`.

## 2. Add the GitHub secrets

The workflow reads six repository secrets:

| Secret                   | Value                                     |
| ------------------------ | ----------------------------------------- |
| `ASC_KEY_ID`             | The API key's Key ID                      |
| `ASC_ISSUER_ID`          | The Issuer ID                             |
| `ASC_API_KEY_P8`         | The `.p8` file, base64-encoded            |
| `APPLE_TEAM_ID`          | Your Team ID                              |
| `IOS_DIST_CERT_P12`      | The `.p12` file, base64-encoded           |
| `IOS_DIST_CERT_PASSWORD` | The password you exported the `.p12` with |

Set them from a terminal. `gh secret set NAME` with no value prompts for it and doesn't echo what you type, and piping `base64` straight in keeps the file contents off your clipboard:

```sh
unset GITHUB_TOKEN   # the shell's token may lack permission to write secrets
gh secret set ASC_KEY_ID --repo zpyoung/quirky
gh secret set ASC_ISSUER_ID --repo zpyoung/quirky
base64 -i AuthKey_XXXXXXXXXX.p8 | gh secret set ASC_API_KEY_P8 --repo zpyoung/quirky
gh secret set APPLE_TEAM_ID --repo zpyoung/quirky
base64 -i QuirkyDistribution.p12 | gh secret set IOS_DIST_CERT_P12 --repo zpyoung/quirky
gh secret set IOS_DIST_CERT_PASSWORD --repo zpyoung/quirky
```

`gh secret list --repo zpyoung/quirky` should then show all six.

## 3. Run a release

Start the workflow from GitHub (Actions > Mobile iOS Release > Run workflow), or from a terminal:

```sh
gh workflow run mobile-ios-release.yml --repo zpyoung/quirky
```

Pushing a tag that matches `mobile-ios-v*` starts it too. The optional inputs are an exact version and an automatic patch bump.

The workflow then does this:

1. A macOS runner (Xcode 26.5) works out the version and build number. The app starts at version `0.0.58` (numbering carried over from the upstream app), and fastlane skips any version App Store Connect has already closed.
2. It builds and signs the app with your certificate and uploads it to App Store Connect. This job has a 90-minute limit.
3. Apple processes the build, which the workflow doesn't wait for. When the build shows as Ready in App Store Connect, your internal group gets it automatically.

## 4. Install it on your phone

1. Install TestFlight from the App Store.
2. Accept the email invite and install Quirky.
3. Open Quirky Mobile and pair it with the desktop app over your local network, or over Tailscale.

## What doesn't work yet

- **Push notifications.** Quirky has no push gateway, so notifications show only while the app is open and connected.
- **Pairing away from home.** The cloud relay was removed, so the phone has to reach the desktop over the same network or through Tailscale.
- **Android.** Releases use `mobile-android-release.yml`, and push there needs your own Firebase project. `mobile/google-services.json` still belongs to the upstream project.

## If the run fails

- **The certificate import fails:** the `.p12` password is wrong, or the secret wasn't base64-encoded.
- **Signing or provisioning profile errors:** check three things. The App ID needs the Push Notifications capability, the certificate must be Apple Distribution (not Development), and `APPLE_TEAM_ID` must be the team that owns the App ID.
- **The run passed but no build reached your phone:** in App Store Connect, check that the build has finished processing, that your internal group has automatic distribution turned on, and that you're a member of it. You can also add the build to the group by hand.
