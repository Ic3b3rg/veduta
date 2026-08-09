# Research 10 — Operator log and trace interfaces

> Conducted on 2026-08-06 against first-party Google Cloud, AWS, and Grafana
> documentation. Scope: interaction and information-design patterns for Veduta's read-only,
> passkey-protected `/app/trace` page, not a recommendation to adopt their telemetry stacks.

## Finding

The useful common pattern is not a dashboard of cards. It is a **dense chronological workbench**:
a compact control bar, an optional event-volume timeline, a scannable list of one-line events, and
details revealed only after selecting a row. Traces are a drill-down from that list, where a nested
waterfall explains one operation end to end. Logs and traces remain distinct views, joined by a
stable trace identifier.

Veduta should borrow that hierarchy while rejecting cloud-console complexity. One self-hosted
installation does not need project pickers, log-group selectors, query languages, saved-query
libraries, service maps, or a permanent field-facet sidebar.

## Patterns in the reference products

### Google Cloud Logs Explorer

Logs Explorer has five explicit regions: primary toolbar, query pane, Fields pane, severity
timeline, and results. The timeline is a histogram split into low, warning, and high severities;
the Fields pane summarizes resource, severity, and frequent structured fields. Results default to
one line per entry, with configurable timestamp density and wrapping. A row can be expanded,
pinned, compared with similar entries, or used to include/exclude a field value.
([interface](https://cloud.google.com/logging/docs/view/logs-explorer-interface))

Streaming is a mode of the same results list, not a separate visual product. It can honor the
current query, and scrolling away from the newest entries pauses the stream. Entries carrying a
trace identifier expose actions to show every log for that trace or open trace details; correlated
parent and child logs can also be nested under one expandable entry.
([streaming and trace navigation](https://cloud.google.com/logging/docs/view/logs-explorer-interface#stream_logs),
[correlated logs](https://cloud.google.com/logging/docs/view/correlate-logs))

**Borrow:** one-line density, a compact severity cue, scroll-to-pause, pinning the current failure,
and direct log-to-trace navigation. **Avoid:** the five-pane desktop layout and general-purpose
query/facet machinery.

Google's current aggregate companion, Observability Analytics (the successor naming to Log
Analytics), opens from Logs Explorer by translating the current Logging query into SQL and can
render the result as a table or chart. That handoff is a useful separation: browsing individual
events and performing aggregate analysis do not have to compete in one initial view.
([Observability Analytics](https://cloud.google.com/logging/docs/analyze/query-and-view))

### AWS CloudWatch Logs

CloudWatch Live Tail separates setup from observation: sources and filter patterns are selected,
then the event stream becomes the main surface. Its status area reports session duration,
matching events per second, and the percentage actually displayed when the incoming rate forces
sampling. Clicking the stream pauses it. A row can expand inline or in a side panel; opening the
side panel also pauses the flow so the selected event can be compared with surrounding events.
([Live Tail](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CloudWatchLogs_LiveTail.html))

The sampling cue is particularly important: above 500 matching events per second, Live Tail can
show only a sample and says so explicitly. The console transport also depends on WebSockets, and a
session has a maximum duration. These facts make connection state, elapsed live time, and missing
data visible product state rather than an invisible implementation detail.

Logs Insights places log sources and a query editor above results, automatically discovers JSON
fields, and offers pattern analysis, query history, and table or chart views. This is appropriate
for fleet-scale investigation, but it is excessive for Veduta's first read-only console.
([Logs Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AnalyzingLogData.html),
[query visualization](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_AnalyzeLogData_VisualizationFieldQuery.html))

**Borrow:** an unmistakable live/pause state, last-event recency, event rate, expandable rows, and
an explicit warning whenever events are omitted. **Avoid:** a configuration form above every live
session and a query language before the basic stream is useful.

### AWS X-Ray

X-Ray uses a clear master-to-detail hierarchy: a filtered trace list opens one trace detail page.
That page combines a short outcome summary with a hierarchical segment/subsegment timeline. Each
row carries status, response code, duration, hosting context, and a horizontal bar positioned
relative to the full trace. Selecting a segment opens structured details for overview, resources,
annotations, metadata, exceptions, and raw JSON.
([trace inspection](https://docs.aws.amazon.com/xray/latest/devguide/xray-console-traces.html))

The service map helps with distributed fleets, but the waterfall is the useful part for Veduta. A
single trace can naturally express a user turn, model attempt, tool calls, Approval card wait,
Surface mutation, retry, and final response without turning every step into an unrelated log row.

**Borrow:** nested rows, relative-duration bars, outcome/duration columns, and structured detail for
the selected step. **Avoid:** a service topology map for one Gateway and treating raw JSON as the
default view.

### Grafana Explore

Grafana's Explore view reinforces the same workbench pattern. Query results combine a log-volume
graph with dense lines; a line's details may appear inline or in a sidebar. “Show context” retrieves
the entries around a selected line, and the selected context can open side by side. Live tail adds
new lines at the bottom with a contrasting background and pauses either through a control or when
the user scrolls.
([logs in Explore](https://grafana.com/docs/grafana/latest/visualizations/explore/logs-integration/))

Its trace timeline exposes expandable spans, events and attributes, then provides a direct
trace-to-logs action that opens the relevant logs alongside the span. This is the strongest
reference for joining two evidence types without merging them into one ambiguous stream.
([traces in Explore](https://grafana.com/docs/grafana/latest/visualizations/explore/trace-integration/))

**Borrow:** surrounding context, inline-or-drawer detail, and bidirectional trace/log links.
**Avoid:** the large matrix of display toggles, deduplication modes, data-source controls, and
desktop-only split panes.

## Product pattern for Veduta

### Page hierarchy

Keep the already-agreed **Activity** and **Runtime logs** views in one `/app/trace` page, but make
each a full-width workbench rather than a collection of cards.

- **Activity:** a restrained volume/status timeline above a dense list of traces. Each row should
  preserve time, outcome, Space, trigger or operation, component, duration, model, and cost. Row
  selection opens the trace waterfall and structured step details.
- **Runtime logs:** a terminal-like stream with timestamp, level, component, and message as stable
  columns. It starts at the newest retained entries and follows new ones. Selecting a row expands
  structured data inline or in a desktop drawer.
- A `traceId` is the bridge: a log entry can isolate its Activity trace, while a trace step can show
  the relevant surrounding runtime lines. Navigation changes context; it does not duplicate or
  fuse the records.

### Live-state contract

The header must always distinguish `LIVE`, `PAUSED BY YOU`, `RECONNECTING`, and `OFFLINE`, show when
the last event arrived, and provide Resume/Jump to latest. When paused by scrolling, retain the
position and show the number of unseen events. A reconnect or file-rotation boundary must appear as
an explicit synthetic row. Veduta should not silently sample its retained 5 MB block; if events are
ever dropped, the row must state the count or unknown gap, following CloudWatch's visible sampling
principle.

The Runtime logs first version does not need filters: all levels remain visible as agreed. Severity
color should be a narrow marker or compact label, never a full-row red or yellow background that
hurts scanning. A volume histogram belongs to retrospective Activity investigation; it should not
steal vertical space from the live terminal.

### Details and density

The default row should be readable without expansion. Large JSON, tool arguments/results,
exceptions, provider-emitted reasoning, and redaction metadata belong in the detail view. Preserve
line breaks and monospace formatting there, with explicit truncation/redaction notices. Expansion
must not cause live content to move under the pointer; selecting details pauses follow mode, as in
CloudWatch Live Tail.

### Mobile

The reviewed cloud consoles are desktop-dense, multi-pane products. Copying their layout literally
would make the remote-phone use case unusable. On a narrow screen, keep the chronological list as
the entire page, reduce each row to time, outcome/level, component, and message, and open details as
a full-screen layer. The waterfall can scroll horizontally while its nested names remain fixed.
Histograms and secondary columns may collapse; live state, pause/resume, unseen-event count, and
error text may not.

## What the next visual exploration should test

1. A Google/AWS-like dense log list as the visual center, not cards or a three-column console.
2. A selected error opening a calm right-side inspector on desktop and full-screen detail on mobile.
3. A trace detail replacing the list with a nested waterfall, with one obvious route back and one
   obvious route to correlated runtime logs.
4. Visually undeniable `LIVE`, paused, reconnecting, rotated-history, and gap states.
5. Useful scanning at realistic density: long component names, multiline errors, concurrent traces,
   redacted fields, and a rapid burst of incoming rows.
