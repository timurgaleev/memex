# Home Assistant Skill

Use this skill to interact with the operator's Home Assistant
deployment.

## CLI: /opt/<project>/bin/ha

Credentials are fetched automatically from Secrets Manager
(`<secrets_prefix>/home-assistant-token`).
Secret format: `{"HA_URL": "https://home.<your-domain>", "HA_TOKEN": "<long-lived-token>"}`

## Commands

### List entity states
```
/opt/<project>/bin/ha states           # all entities
/opt/<project>/bin/ha states light     # filter by keyword
/opt/<project>/bin/ha states sensor
```

### Get raw API response
```
/opt/<project>/bin/ha get /api/        # API status
/opt/<project>/bin/ha get /api/states/light.living_room
```

### Call a service (control devices)
```
/opt/<project>/bin/ha call light turn_on  '{"entity_id":"light.living_room"}'
/opt/<project>/bin/ha call light turn_off '{"entity_id":"light.living_room"}'
/opt/<project>/bin/ha call switch turn_on '{"entity_id":"switch.my_switch"}'
/opt/<project>/bin/ha call climate set_temperature '{"entity_id":"climate.living_room","temperature":21}'
```

### State history
```
/opt/<project>/bin/ha history sensor.temperature 24   # last 24 hours
```

## When to use proactively

- When the user asks about home temperature, lights, sensors, energy,
  or any device
- When the user asks to turn something on / off or adjust a setting
- When the user asks what is happening at home
- Always check states before acting so you know current values

## Entity naming

If unsure of an entity ID, run `ha states` with a keyword filter first,
then act on the correct entity.
