# Product demo and media

The first distribution demo shows one useful result: a Weekly plan in Work changes through Chat,
then remains after refresh. It uses fictional data and the deterministic mock Model connection.
It does not measure real-model quality or prove integrations, passkeys, Automations or a physical phone.

## Record with Claude Code

Install the repository's Node.js and pnpm versions, then:

```sh
pnpm install --frozen-lockfile
pnpm --filter @veduta/e2e exec playwright install chromium
brew install ffmpeg # macOS; use your distribution's ffmpeg package on Linux
pnpm demo:record
```

The command builds the PWA, starts the real Gateway on an OS-assigned loopback port, and records
the browser at 1440 × 900. It uses a fresh temporary data directory, strips provider/configuration
environment variables, and disables general command execution. It never loads your personal
Gateway data. Temporary data and raw WebM recordings are removed when the run finishes.

Ask Claude Code from the repository:

> Run `pnpm demo:record`, inspect the three PNGs and sample frames of the MP4, check that its
> duration is 45–90 seconds, and report whether the script's refresh and Gateway restart checks passed.
> Preserve the fictional data and mock-provider disclosure. Do not use a real Model connection.

The script is independent of the E2E test suite. For screenshots alone, use
`pnpm demo:record --screenshots-only`. For manual capture with the shared browser or macOS screen
recording, build the PWA and run `pnpm --filter @veduta/e2e demo:record --serve`, then open its
printed localhost URL. This separate local Gateway is a recording tool, **not a public demo server**.
Ctrl-C removes that environment. You do not need to start `pnpm dev`.

### Storyboard and transcript

1. **Home:** show the fictional Home, Health and Reading Spaces.
2. **Create:** send `Create a Space called Work.` and accept the Create Space proposal.
3. **Prepare:** in Work, send `Prepare a weekly plan with three priorities: ship the prototype,
talk to testers, and write release notes.`
4. **Change:** send `Move tester interviews to Tuesday and make them the top priority.`
5. **Persist:** refresh; show Tuesday and Talk to testers in the same Surface, with the retained
   Chat timeline. Return to Home and reopen Work.

Readable pauses and typed prompts make the full video about a minute. Built-in captions also
ship as a WebVTT track for the landing. The script separately restarts the real Gateway and
compares the saved Surface to the pre-restart result. It fails on a missing expected result,
browser exception or external browser request; do not publish output from a failed run.

### Delivered files

| File in `docs/media/`      | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `veduta-demo.mp4`          | H.264 video with `faststart` for browser playback              |
| `veduta-demo.gif`          | Accelerated, palette-optimized preview linked to the video     |
| `veduta-demo.vtt`          | English captions                                               |
| `home-desktop.png`         | Actual Home at 1440 × 900                                      |
| `home-mobile.png`          | Actual Home at a 390 × 844 viewport; not a device photograph   |
| `surface-before-after.png` | Two actual captures of the same Surface with comparison labels |
| `capture.json`             | Scenario, provider, capture dimensions and checks performed    |

The three PNGs, GIF, MP4 and captions are intentional repository assets used by the README
and landing. Build output, temporary data and raw recordings are not committed. Regenerate the
whole set after a visible product change and review the files before publishing. Keep the GIF
short and below 5 MB; use the MP4 for the readable full journey. The silent video needs no audio
to understand it, and the landing provides captions and a text transcript.

## Publish the landing and guided demo

```sh
pnpm demo       # http://localhost:5190, with /demo.html for the tour
pnpm demo:build
pnpm --filter @veduta/website preview
pnpm demo:check # built-site browser checks, including a static-host subpath
```

Publish **only `packages/website/dist/`** to a dedicated static site, such as GitHub Pages,
Cloudflare Pages or a static object host. Its `index.html` is the landing; `demo.html` is the tour.
Asset URLs are relative and HashRouter keeps tour navigation working under a repository subpath
without server rewrites.

### GitHub Pages

The [`pages.yml`](../.github/workflows/pages.yml) workflow builds the website and publishes only
`packages/website/dist/` on pushes to `main`, or when run manually from Actions. In repository
Settings → Pages, select **GitHub Actions** as the source; no template or additional secret is needed.
The expected URL is `https://ic3b3rg.github.io/veduta/`. Verify the successful deployment and public
browser behavior before advertising it. To roll back, revert the website change on `main` and let
the workflow publish the previous implementation again.

The tour imports the product's Home, Chat and Space presentation components and the same scenario
used by the mock provider. It has **no Gateway runtime, network inference, service setup, secrets,
shell tools, account access, telemetry or third-party scripts**. Every visitor's changes live only
under `veduta.public-demo.v1` in that browser's local storage. Storage failures are visible; resetting
the tour touches only that key. Clearing storage, private browsing or switching browser/device can
remove or change that state. It is an interface tour, not an alternative production persistence layer.

Serve it from its own origin, separate from a personal Gateway. The build includes
[`_headers`](../packages/website/public/_headers) for hosts that support that format, including
a Content Security Policy with `connect-src 'none'`. On other static hosts, apply the same
headers through their configuration. GitHub Pages does not apply this `_headers` file or expose
custom response-header configuration; its deployment therefore does not enforce that extra CSP.
The tour still contains no Gateway client or executable tools. The development server needs its own HMR WebSocket;
the strict policy is for the built site.
Do not proxy `/api` or `/ws` to a Gateway. The public tour is static by design.

Before publication, set the site's real canonical URL and absolute social-preview image URL in
`packages/website/index.html`; these cannot be truthfully set before a host is chosen. Fonts are
self-hosted Inter with its bundled SIL Open Font License.

## Browser QA

1. Open `/demo.html` in a fresh browser context. Confirm the mock/fictional-data disclosure.
2. Send the Space prompt through Chat, accept Work, and use the plan prompt. Confirm the Surface.
3. Send the edit prompt, refresh and reopen Work. Check Tuesday, the top priority and retained Chat.
4. Open a separate browser context. Its tour starts fresh. Reset the first context; unrelated
   storage must remain untouched. Corrupt or block demo storage and confirm the visible recovery message.
5. Repeat at 390 px and desktop width, using keyboard and pointer. Check no horizontal overflow,
   readable controls and usable Chat. These viewport checks do not replace physical-phone acceptance.
6. Open the landing. Play the MP4 with captions, open the transcript, and follow the GitHub,
   local trial, self-hosting and tester links. Inspect network requests: the built tour calls no API
   or external origin. Verify the same behavior from the chosen public URL after deployment.

Implementation references: [Playwright video lifecycle](https://playwright.dev/docs/videos),
[Vite static deployment](https://vite.dev/guide/static-deploy.html), and
[FFmpeg palette filters](https://ffmpeg.org/ffmpeg-filters.html#palettegen).
