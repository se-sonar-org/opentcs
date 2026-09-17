<!-- SPDX-FileCopyrightText: The openTCS Authors -->
<!-- SPDX-License-Identifier: MIT -->

# openTCS Fleet 3D Viewer

A standalone, build-free web page that renders the plant layout and live
vehicle positions of a running openTCS kernel in 3D using
[Three.js](https://threejs.org/) (loaded from a CDN via an import map, so no
`npm install` step is required).

It talks to the kernel's existing Service Web API (`opentcs-kernel-extension-http-services`):

- `GET /v1/plantModel` once, to draw points and paths.
- `GET /v1/vehicles` on a timer, to animate vehicles between polls.

## Usage

1. Start the openTCS kernel with the Service Web API enabled (enabled by
   default, listening on port `55200`).
2. Serve this directory over HTTP, e.g.:
   ```
   npx http-server opentcs-webviewer -p 8081
   ```
   (Opening `index.html` directly via `file://` also works, since the API
   already sends permissive CORS headers.)
3. Open the served page in a browser, enter the kernel's API base URL
   (default `http://localhost:55200/v1`) and, if `servicewebapi.accessKey`
   is configured, the matching access key. Click **Connect**.

Vehicles appear as colored boxes with a heading cone and name label; color
reflects the vehicle's reported state (see the legend in the sidebar).
Click a vehicle in the sidebar list to focus the camera on it.

## Notes

- Coordinates are converted from the plant model's millimeters to meters,
  and vehicle heading is derived from `orientationAngle`. Depending on how a
  given plant model was authored, the mapping between plant XY and 3D
  world axes may need adjusting for visual convention.
- Vehicles without a known position (no `precisePosition` and an unresolved
  `currentPosition`) are not shown.
