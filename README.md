# travelroute-card

A custom [Home Assistant](https://www.home-assistant.io/) Lovelace card that visualises a vehicle's travel route on an interactive map. It reads GPS position history from the HA History API, calculates a road-accurate route via [OSRM](https://project-osrm.org/), and marks parking stops longer than a configurable threshold.

![travelroute-card screenshot placeholder](https://via.placeholder.com/800x420?text=travelroute-card+screenshot)

---

## Features

- Fetches GPS history directly from Home Assistant's History API (no extra integration needed)
- Road-accurate routing via the public OSRM API (no API key required)
- Interactive [Leaflet](https://leafletjs.com/) map with CartoDB Light tile layer
- Automatic park stop detection based on time gaps between position updates
- Configurable date range picker with a "Last N days" quick button
- Scrollable stop list with arrival, departure, and duration per stop
- Chunked OSRM requests (max 80 waypoints each) to handle long trips
- Works inside Home Assistant's Shadow DOM — scroll events handled correctly

---

## Requirements

- Home Assistant with the History integration enabled (enabled by default)
- **Either**:
  - A single entity (e.g., `device_tracker` or geocoded location sensor) that contains location data in its attributes (like `latitude`/`longitude` or a `location` array).
  - **Or** two sensor entities that record latitude and longitude as their state — one value each, updated whenever the vehicle moves. Examples:
    - `sensor.my_car_position_latitude`
    - `sensor.my_car_position_longitude`
- Internet access from the browser (Leaflet CSS/JS and OSRM are loaded from CDN)

---

## Installation

### Manual

1. Download `travelroute-card.js` from this repository.
2. Copy it to your Home Assistant `config/www/` folder (create the folder if it does not exist).
3. In Home Assistant, go to **Settings → Dashboards → Resources** and add a new resource:
   - **URL:** `/local/travelroute-card.js`
   - **Type:** JavaScript module
4. Clear your browser cache and reload the dashboard.

### HACS (manual repository)

1. Open **HACS**.
2. Click the three-dot menu → **Custom repositories**.
3. Add `https://github.com/fscorrupt/ha-travelroute-card` with category **Dashboard** (or **Lovelace** in older versions).
4. Search for "Travel Route Card" and install it.
5. Clear your browser cache and reload.

---

## Configuration

Add the card to your dashboard via the Lovelace YAML editor or the card picker.

```yaml
type: custom:travelroute-card
entity: device_tracker.my_car
# OR use two separate sensors:
# lat_entity: sensor.my_car_position_latitude
# lon_entity: sensor.my_car_position_longitude
```

### Options

| Option               | Type    | Default          | Description                                              |
|----------------------|---------|------------------|----------------------------------------------------------|
| `entity`             | string  |                  | Entity ID of a device tracker or sensor with location attributes. **Requires either this OR `lat_entity`/`lon_entity`.** |
| `lat_entity`         | string  |                  | Entity ID of the latitude sensor.                        |
| `lon_entity`         | string  |                  | Entity ID of the longitude sensor.                       |
| `title`              | string  | `Travel Route`   | Card title displayed in the header                       |
| `default_days`       | number  | `7`              | Number of days to load by default                        |
| `park_threshold_min` | number  | `15`             | Minimum gap in minutes between positions to count as a stop |
| `map_height`         | string  | `420px`          | Height of the map area (any valid CSS value)             |

### Full example

```yaml
type: custom:travelroute-card
lat_entity: sensor.cupra_tavascan_position_latitude
lon_entity: sensor.cupra_tavascan_position_longitude
title: CUPRA Tavascan – Travel Route
default_days: 7
park_threshold_min: 15
map_height: 480px
```

---

## How it works

1. On load the card fetches the full state history of both position sensors for the selected date range from the HA History API (`history/period/…`).
2. Latitude and longitude entries are paired by closest timestamp (within 5 seconds).
3. Consecutive duplicate positions are removed.
4. Time gaps larger than `park_threshold_min` between consecutive points are recorded as park stops.
5. The remaining waypoints are sent to the public OSRM routing API in chunks of up to 80 points to obtain a road-snapped polyline.
6. Leaflet renders the polyline, waypoint markers, park stop markers (orange **P**), and start (**S**) / end (**E**) markers on a CartoDB Light map.

---

## External dependencies

Both dependencies are loaded at runtime from a CDN. No bundling or build step is required.

| Dependency | Version | Source |
|------------|---------|--------|
| Leaflet    | 1.9.4   | `unpkg.com` |
| OSRM       | public API | `router.project-osrm.org` |

> **Note:** The public OSRM demo server is rate-limited and intended for development/personal use. For production or high-frequency use, consider hosting your own OSRM instance and updating `OSRM_BASE` at the top of the file.

---

## License

MIT © [fscorrupt](https://github.com/fscorrupt)
