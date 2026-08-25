# Fixed PWA screens use a declarative client router

The PWA shell now has several fixed screens: Home, first-boot setup, Model connections, and the
Space and Surface entry points. Selecting those screens through a mixture of local React state,
pathname parsing, direct History API calls, and service-worker message handling allowed the URL,
browser history, and rendered screen to disagree as the shell grew.

The PWA uses React Router in declarative mode with one fixed route table. The URL is the source of
truth for fixed-screen selection and for the active `spaceSlug` and `surfaceId`; clicks,
Back/Forward, setup completion, and service-worker navigation all enter through the router API.
Authentication and onboarding remain guards around the routed shell, so a protected deep link is
retained while those guards settle and completed setup replaces its URL with Home.

The route table is application code owned by the PWA. Spaces and Surfaces contribute only encoded
route parameters and protocol-validated data. Agent output cannot register, replace, or redefine a
route. A routed Surface still renders a validated tree from the closed Atom catalog; routing does
not add an Atom type, generated markup, or another rendering path.

Extending the hand-written History API approach was rejected. It would require every new screen and
navigation source to coordinate local state, `pushState`, `popstate`, pathname parsing, and guard
timing manually, preserving multiple authorities for the same visible state. Gateway-owned routing
was also rejected for this slice: the Gateway continues to serve the same PWA shell for `/`,
`/setup`, and `/app/*`, while the client resolves the fixed screen.

The added router is a client dependency and contributes to the initial JavaScript bundle. It ships
as side-effect-free ESM, so the production build can tree-shake unused APIs; route-specific code
may be split when measurement shows an initial-load benefit.

Status: accepted
