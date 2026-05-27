---
name: weather-query
category: output
compatibility: Designed for FlopsyBot agent
description: Output template for weather answers. Use whenever the user asks about current conditions or forecast — enforces locale-aware units, structured layout, and a source URL.
when-to-use: "Use BEFORE composing the reply, whenever a user message asks about weather, forecast, rain, temperature, or 'how's it outside'. Loads the structured 3-section template with locale-correct units."
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

# weather-query — output template

When the user asks about weather, the reply MUST follow this template.

## Trigger phrases
- "weather in X" / "what's the weather"
- "is it raining" / "will it rain"
- "temperature in X"
- "forecast" / "tomorrow's weather"
- "should I bring an umbrella / coat / jacket"
- "how's it outside"

## Units — read `<runtime>` first

The `<runtime>` block carries a `units:` line. Use that. Concretely:
- `units: metric` → °C, km/h, mm of rain, m, kg. **Never** °F / mph / inches / lb.
- `units: imperial` → °F, mph, in, ft, lb. Skip metric conversions unless asked.

If the user explicitly asks "in Fahrenheit" or "in mph", honor that for the turn — don't refuse, don't add a conversion in parentheses.

## The shape (mandatory)

```
🌤️ <city>, <country/region> — <local time>
  Now: <condition>, <temp> (feels like <feels>)
  Wind: <speed> <direction>  ·  Humidity: <%>  ·  Precip: <%>
  Today: <morning summary> / <afternoon> / <evening>
  Tomorrow: <high>/<low>, <one-line summary>
  Bring: <one-line wear/take advice — e.g. "light jacket morning, umbrella optional">

Source: <https://full.url.from.tool>
```

That's it. Five short lines + source. No prose intro ("Right now in..."). No closing question.

## Hard rules

1. **Always include a source URL.** Copy the link from the weather tool's response verbatim. The word "Source" alone is not a citation — it must be a clickable URL.
2. **Use the locale units from `<runtime>`.** Don't override with the source's default. AccuWeather defaults to °F for many regions — convert it.
3. **Specify the location precisely.** "Kashiwa, Chiba, Japan" beats "Kashiwa." If only one city name is given and there's ambiguity, ask once.
4. **No raw dumps.** Pull only the fields shown above. Don't include UV index, sunrise, dewpoint, pressure unless the user asked.
5. **"Bring" line is one short imperative.** "Bring an umbrella" / "Dress warm" / "Light layers fine" / "Sunscreen — UV high." Skip the line if nothing useful.

## Anti-patterns — instant failure

- ❌ `Right now in Kashiwa: 59°F (15°C), light rain. Wind NNE 17 mph gusting to 25 mph. Air quality fair. Feels like 53°F. Source` — °F first in Japan locale, no source URL, no structure, "Source" label without link.
- ❌ Dumping every field the tool returned (UV, dewpoint, pressure, etc.) — pick the user-facing five.
- ❌ Adding `(15°C)` after `59°F` for a metric-locale user — just use °C. Conversions in parens read like the agent doesn't trust the user's locale.
- ❌ Forgetting the "Bring:" line — that's the value-add, otherwise this is just numbers.

## Fallback when the weather tool fails

If the weather tool errors, times out, or returns empty, do NOT fabricate. Pull the numbers from `wttr.in` — no API key, takes any city name or airport code, fetch-friendly via `web_extract` / `http_request`:
- JSON: `https://wttr.in/<City>?format=j1` → `current_condition[0]` (temp_C/temp_F, FeelsLikeC, weatherDesc, windspeedKmph, winddir16Point, humidity, chanceofrain) + `weather[0..2]` (daily max/min). e.g. `https://wttr.in/Austin?format=j1`, `https://wttr.in/New+York?format=j1`.
- Quick line: `https://wttr.in/<City>?format=%l:+%c+%t+feels+%f+wind+%w+humidity+%h`

Do NOT `web_extract` consumer sites like AccuWeather / Weather.com — they return HTTP 403 to bots and only render in a real browser; use such a page only as the human Source link the user can click. If `wttr.in` fails, `web_search("<city> weather forecast today")`. If all fail, say the lookup failed and name what you tried — never invent conditions.

## Forecast horizon

- "weather now" / "is it raining" → emit the `Now:` line + `Bring:` only. Skip Today/Tomorrow.
- "weather today" → full template, but Tomorrow line is optional.
- "weather tomorrow" / "this weekend" → emphasize Tomorrow / multi-day; Now line can be brief.

## Example — strong (metric locale, Japan)

> User: "weather in Kashiwa?"
>
> ```
> 🌤️ Kashiwa, Chiba — 10:23 JST
>   Now: light rain, 15°C (feels like 12°C)
>   Wind: 27 km/h NNE, gusts to 40  ·  Humidity: 78%  ·  Precip: 95%
>   Today: rain easing midday, cloudy afternoon, 17°C peak
>   Tomorrow: 19°/14°, mostly cloudy, 30% rain late
>   Bring: umbrella now, jacket all day.
>
> Source: https://www.accuweather.com/en/jp/kashiwa-shi/223074/weather-forecast/223074
> ```

## Example — strong (imperial locale, US)

> User: "weather in Austin?"
>
> ```
> 🌤️ Austin, TX — 09:14 CST
>   Now: sunny, 72°F (feels like 70°F)
>   Wind: 8 mph SE  ·  Humidity: 45%  ·  Precip: 5%
>   Today: warming to 81°F, light breeze all afternoon
>   Tomorrow: 78°/61°, partly cloudy
>   Bring: sunglasses, light layers fine.
>
> Source: https://www.accuweather.com/en/us/austin-tx/78701/weather-forecast/351193
> ```

## Example — weak (do not do)

> ❌ `Right now in Kashiwa: 59°F (15°C), light rain, wind NNE 17 mph gusting to 25 mph, feels like 53°F. Source`

Wrong unit lead, mph in metric locale, no URL, no structure, no "Bring" advice — pure data dump with a broken citation. This is the failure mode this skill exists to prevent.
