---
name: home-assistant
compatibility: Designed for FlopsyBot agent
description: Control smart home devices via Home Assistant MCP tools. Turn lights on/off, adjust climate, check sensors, view history, trigger automations. Tools are prefixed with ha_.
---

# Home Assistant

Control smart home devices through Home Assistant MCP tools. All tools are prefixed with `ha_`.

## When to Use This Skill

- User wants to control lights, switches, or plugs
- User asks about temperature, humidity, or sensor readings
- User wants to adjust thermostat or HVAC
- User asks "what devices are on?" or about home status
- User wants to trigger automations or scenes
- User asks about device history

## Tool Reference

### ha_list_entities

List all entities (devices). Use this FIRST to discover entity IDs.

```
ha_list_entities()                          // all entities
ha_list_entities({ domain: "light" })       // only lights
ha_list_entities({ domain: "switch" })      // only switches
ha_list_entities({ domain: "sensor" })      // only sensors
ha_list_entities({ domain: "climate" })     // only thermostats
ha_list_entities({ domain: "automation" })  // only automations
```

**Parameters:**
- `domain` (string, optional): Filter by domain — `light`, `switch`, `sensor`, `climate`, `binary_sensor`, `automation`, `scene`, `cover`, `fan`, `media_player`

### ha_get_state

Get current state of a specific entity.

```
ha_get_state({ entityId: "sensor.temperature" })
ha_get_state({ entityId: "light.living_room" })
```

**Parameters:**
- `entityId` (string, required): Full entity ID like `light.living_room`

### ha_turn_on

Turn on a device. Supports brightness and color for lights.

```
ha_turn_on({ entityId: "light.bedroom" })
ha_turn_on({ entityId: "light.bedroom", brightness: 128 })
ha_turn_on({ entityId: "light.bedroom", brightness: 255, color: "blue" })
ha_turn_on({ entityId: "switch.coffee_maker" })
```

**Parameters:**
- `entityId` (string, required): Entity to turn on
- `brightness` (number, optional): 0–255, only for lights
- `color` (string, optional): Color name ("red", "blue") or hex code, only for lights

### ha_turn_off

Turn off a device.

```
ha_turn_off({ entityId: "light.bedroom" })
ha_turn_off({ entityId: "switch.coffee_maker" })
```

**Parameters:**
- `entityId` (string, required): Entity to turn off

### ha_toggle

Toggle a device on/off.

```
ha_toggle({ entityId: "light.desk_lamp" })
```

**Parameters:**
- `entityId` (string, required): Entity to toggle

### ha_set_climate

Control thermostat/HVAC settings.

```
ha_set_climate({ entityId: "climate.thermostat", temperature: 22 })
ha_set_climate({ entityId: "climate.thermostat", mode: "cool" })
ha_set_climate({ entityId: "climate.thermostat", temperature: 24, mode: "heat" })
```

**Parameters:**
- `entityId` (string, required): Climate entity ID
- `temperature` (number, optional): Target temperature
- `mode` (string, optional): One of `auto`, `heat`, `cool`, `off`, `dry`, `fan_only`

### ha_call_service

Call any Home Assistant service. Use for automations, scenes, and anything not covered by other tools.

```
// Trigger an automation
ha_call_service({ domain: "automation", service: "trigger", data: { "entity_id": "automation.good_night" } })

// Activate a scene
ha_call_service({ domain: "scene", service: "turn_on", data: { "entity_id": "scene.movie_time" } })

// Lock a door
ha_call_service({ domain: "lock", service: "lock", data: { "entity_id": "lock.front_door" } })

// Send a notification
ha_call_service({ domain: "notify", service: "mobile_app", data: { "message": "Motion detected", "title": "Alert" } })
```

**Parameters:**
- `domain` (string, required): Service domain — `automation`, `scene`, `lock`, `notify`, `media_player`, etc.
- `service` (string, required): Service name — `trigger`, `turn_on`, `turn_off`, `lock`, `unlock`, etc.
- `data` (object, optional): Service data — always include `entity_id` when targeting a specific device

### ha_get_history

Get historical state changes for an entity.

```
ha_get_history({ entityId: "binary_sensor.front_door" })
ha_get_history({ entityId: "sensor.temperature", startTime: "2026-02-18T00:00:00Z" })
ha_get_history({ entityId: "light.bedroom", startTime: "2026-02-17T00:00:00Z", endTime: "2026-02-18T00:00:00Z" })
```

**Parameters:**
- `entityId` (string, required): Entity to get history for
- `startTime` (string, optional): ISO 8601 start time
- `endTime` (string, optional): ISO 8601 end time

### ha_list_services

List available services, optionally filtered by domain.

```
ha_list_services()                          // all services
ha_list_services({ domain: "light" })       // light services only
ha_list_services({ domain: "climate" })     // climate services only
```

**Parameters:**
- `domain` (string, optional): Filter by service domain

## Entity ID Format

Entity IDs follow `domain.name`:
- `light.living_room`, `light.bedroom`
- `switch.desk_lamp`, `switch.coffee_maker`
- `sensor.temperature`, `sensor.humidity`
- `climate.thermostat`, `climate.bedroom_ac`
- `binary_sensor.front_door`, `binary_sensor.motion`
- `automation.good_night`, `scene.movie_time`

**IMPORTANT: Always call `ha_list_entities` first** to discover actual entity IDs. Never guess entity IDs — they vary per installation.

## Common Workflows

### "What's going on at home?"
1. `ha_list_entities()` → get all entities
2. Summarize: which lights/switches are on, current sensor readings, any unusual states

### "Turn on the living room light"
1. `ha_list_entities({ domain: "light" })` → find the exact entity ID
2. `ha_turn_on({ entityId: "light.living_room" })`

### "Set the temperature to 22"
1. `ha_list_entities({ domain: "climate" })` → find thermostat entity ID
2. `ha_set_climate({ entityId: "climate.thermostat", temperature: 22 })`

### "Run the good night routine"
1. `ha_list_entities({ domain: "automation" })` → find the automation
2. `ha_call_service({ domain: "automation", service: "trigger", data: { "entity_id": "automation.good_night" } })`

## Response Style

- Use friendly names, not raw entity IDs: "Living room light is on at 70%" not "light.living_room state: on"
- For sensors, include units: "22.5°C" not "22.5"
- Confirm actions: "Done — bedroom light is on" not just "Success"
- If entity not found, run `ha_list_entities` and suggest closest matches
