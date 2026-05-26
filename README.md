# Fluke 287 Logger

Chrome(Firefox experimental in nightly build under linux) extension for logging Fluke 287 measurements through the Web Serial API.

## Install locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this project directory.

## Build Chrome Web Store package

Create the upload zip from the project root:

```sh
zip -r fluke-287-logger-cws-0.1.0.zip manifest.json index.html styles.css app.js service-worker.js icons LICENSE PRIVACY.md
```

The Chrome Web Store upload package must contain `manifest.json` at the zip root.

## Notes

- Requires a Chromium-based browser with Web Serial support.
- Serial access is granted by the user through the browser's device picker.
- No external runtime dependencies are required.

## Trademark notice

This project is not affiliated with, endorsed by, or sponsored by Fluke Corporation.
Fluke is a trademark of Fluke Corporation. The name is used only to describe
compatibility with Fluke 287 multimeters.

## License

This project is licensed under the GNU General Public License v3.0 only.
See [LICENSE](LICENSE) for details.
