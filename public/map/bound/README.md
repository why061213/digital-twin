# Local administrative boundaries

Province and city GeoJSON files in this directory are sourced from
`zhChuXiao/ChinaGeoJson` and renamed to `{parentAdcode}_full.json` so the
dashboard can load province, city, and district boundaries without internet
access.

Source: https://github.com/zhChuXiao/ChinaGeoJson
License: MIT, see `LICENSE-ChinaGeoJson.txt`.

The `province` source files provide city boundaries. The `citys` source files
provide district/county boundaries. County source files are intentionally not
bundled because the dashboard does not render township boundaries.
