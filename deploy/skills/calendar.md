# calendar — Google Calendar

Read the operator's Google Calendar via the `gcal` CLI. Credentials
auto-fetched from AWS Secrets Manager (`<secrets_prefix>/google-calendar`).

CLI: `/opt/<project>/bin/gcal`

## Commands

```bash
/opt/<project>/bin/gcal today              # today's events
/opt/<project>/bin/gcal tomorrow           # tomorrow's events
/opt/<project>/bin/gcal week               # next 7 days
/opt/<project>/bin/gcal list 14            # next 14 days
/opt/<project>/bin/gcal search "dentist"   # search events (30 days)
/opt/<project>/bin/gcal calendars          # list all calendars
```

## When to use

- When the operator asks "what do I have today / this week / tomorrow"
- In a morning briefing: include today's events (skip public holidays
  unless relevant)
- When asked about upcoming appointments, travel, or schedule
- When scheduling context is needed for a decision

## Notes

- Read-only access (`calendar.readonly` scope)
- Credentials in `<secrets_prefix>/google-calendar` (client_id,
  client_secret, refresh_token)
- Refresh token expires every 7 days while the OAuth app is in "Testing"
  mode — re-auth needed if expired
