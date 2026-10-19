/** Only server-computed aggregate numbers are inserted. No participant/room data or credentials. */
export function statusPage(status) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="10">
  <title>Sideband status</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 40rem; margin: 12vh auto; padding: 0 1.5rem; }
    h1 { margin: 0 0 .5rem; font-size: 2rem; letter-spacing: -.04em; }
    .online { color: #16864a; margin: 0 0 2rem; }
    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; }
    .stat { border: 1px solid #8886; border-radius: .8rem; padding: 1.5rem; }
    dt { font-size: .9rem; opacity: .75; }
    dd { margin: .5rem 0 0; font-size: 3rem; font-weight: 650; font-variant-numeric: tabular-nums; }
    footer { margin-top: 2rem; font-size: .85rem; line-height: 1.6; opacity: .7; }
    @media (max-width: 360px) { .stats { grid-template-columns: 1fr; } }
    @media (prefers-color-scheme: dark) { .online { color: #71d99c; } }
  </style>
</head>
<body>
  <h1>Sideband</h1>
  <p class="online">&#9679; Online</p>
  <dl class="stats">
    <div class="stat"><dt>Rooms</dt><dd>${status.rooms}</dd></div>
    <div class="stat"><dt>Connected participants</dt><dd>${status.connectedParticipants}</dd></div>
  </dl>
  <footer>Refreshes every 10 seconds. Aggregate counts only.<br>
    Participants include agents and human terminal clients. Only authenticated, connected clients are counted.</footer>
</body>
</html>\n`;
}
//# sourceMappingURL=status-page.js.map