---
name: kuikly-page-inspect
description: Inspect a live Kuikly page through kuikly-devtools when debugging UI structure, component state, device logs, network requests, or native module calls. Use the paginated CLI search rather than loading a full page snapshot.
---

# Kuikly Page Inspect

Use this skill whenever the task depends on what a running Kuikly page currently displays, logs, or requests. The DevTools server must be running and the page must have attached through an instrumented build.

Run commands from the Kuikly project root. All output is JSON.

```bash
npx kuikly-devtools inspect sessions
npx kuikly-devtools inspect logs --pager <pager-id> --query <text> --limit 50
npx kuikly-devtools inspect network --pager <pager-id> --query <url-or-stack> --status 500
npx kuikly-devtools inspect native --pager <pager-id> --query <module-or-method>
npx kuikly-devtools inspect nodes --pager <pager-id> --query <view-or-class>
```

Start with `sessions`, choose a live `pagerId`, then query only the relevant data type. Use `--offset` and `--limit` to page through results. Logs accept `--level` (`i`, `d`, `e`, or `p`) and `--tag`; network accepts `--status` and `--kind`; native accepts `--kind` (`sync`, `async`, or `stream`).

Use an explicit detail lookup only after finding its ID in a search result:

```bash
npx kuikly-devtools inspect network-detail --pager <pager-id> --id <request-id>
npx kuikly-devtools inspect native-detail --pager <pager-id> --id <call-id>
npx kuikly-devtools inspect log-detail --pager <pager-id> --id <log-seq>
npx kuikly-devtools inspect node-detail --pager <pager-id> --id <node-id>
```

Never request the legacy full session endpoint for investigation. Search results contain summaries and body previews. Results at or below 15 KiB are returned as JSON; only a result larger than 15 KiB is written to `<project>/.kuiklyPageTemp/`, with the CLI returning `{ "savedTo": "..." }`. Read that file selectively with line- or field-oriented commands; do not paste the whole file into context. The directory is ignored by Git and remains visible for manual cleanup.

```bash
npx kuikly-devtools inspect clean-temp
```

When the server is unavailable or `sessions` is empty, say that live page data is not attached yet and use `npx kuikly-devtools dev`, `build-js`, `build-apk`, or `gradle -- <task>` to start/reuse the service and make an instrumented build.
