# Intro → Apple Wallet

The **🎟 Wallet** button on a card serves a real, signed `.pkpass` — your
business card in Apple Wallet, with the share link as its QR code so anyone
who scans the pass opens your live card.

**Why setup is needed at all:** iPhones only open Wallet passes that are
cryptographically signed with a *Pass Type ID certificate* issued through the
[Apple Developer Programme](https://developer.apple.com/programs/) (paid).
That's a platform rule — no library or service can skip it. Intro ships the
entire pipeline (`intro/pass.mjs` builds and signs, `intro/server.mjs` serves)
with **zero npm dependencies**; you only bring the certificate.

## 1. Get the certificates (one-time, ~15 minutes)

1. Join the Apple Developer Programme, then in
   [Certificates, Identifiers & Profiles → Identifiers](https://developer.apple.com/account/resources/identifiers/list/passTypeId)
   create a **Pass Type ID**, e.g. `pass.com.yourname.intro`.
2. Create a certificate for it (upload a CSR from Keychain Access →
   Certificate Assistant → *Request a Certificate From a Certificate
   Authority*), download the `.cer`, and double-click to add it to Keychain.
3. Export it from Keychain as `pass.p12` (set a passphrase), then convert:

   ```sh
   openssl pkcs12 -in pass.p12 -clcerts -nokeys -legacy -out pass-cert.pem
   openssl pkcs12 -in pass.p12 -nocerts -legacy -out pass-key.pem   # keeps the passphrase
   ```

4. Download Apple's **WWDR G4 intermediate** from
   [apple.com/certificateauthority](https://www.apple.com/certificateauthority/)
   and convert: `openssl x509 -inform der -in AppleWWDRCAG4.cer -out wwdr.pem`.
5. Your **Team ID** is on the developer account membership page (e.g. `AB12CD34EF`).

## 2. Run the pass server

```sh
PASS_TYPE_ID=pass.com.yourname.intro \
TEAM_ID=AB12CD34EF \
PASS_CERT=pass-cert.pem \
PASS_KEY=pass-key.pem \
PASS_KEY_PASSPHRASE=your-p12-passphrase \
WWDR_CERT=wwdr.pem \
node intro/server.mjs
```

Deploy it anywhere Node runs (Render/Railway/Fly — the repo's `render.yaml`
shows the pattern); it's a single file with no dependencies. Keep the `.pem`
files out of git.

## 3. Point the app at it

Edit [`intro/config.js`](./config.js):

```js
window.IntroConfig = { passEndpoint: 'https://your-pass-server.example.com' };
```

Done — the 🎟 Wallet button now downloads a signed pass. On an iPhone it opens
straight into the *Add to Apple Wallet* sheet.

## Notes

- The server never sees more than the card token the app already shares by
  link; certificates never leave the server.
- The pass QR encodes the card link *without* the photo (QR capacity), same
  as the in-app QR.
- Google Wallet needs a different (also signed) format — not included yet.
